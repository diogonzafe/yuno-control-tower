import pino from "pino";

import {
  buildTransactionCells,
  type GeneratorCatalog,
  type MerchantTrafficWeights,
  type WeightedTransactionCell,
} from "./catalog.ts";
import type { GeneratorIncident } from "./incident.ts";
import { createSeededRandom, type SeededRandom } from "./random.ts";
import { generateTransaction } from "./transaction.ts";
import { transactionsPerSecond } from "./volume.ts";

const logger = pino({ name: "generator-engine", level: process.env.VITEST ? "silent" : "info" });

// Ten seconds of backlog at the default 60 TPS. Past this the generator is
// losing to its sink and should shed load rather than queue it forever.
const MAX_CARRY_EVENTS = 600;

export type TransactionGenerator = {
  next: (at?: Date) => ReturnType<typeof generateTransaction>;
  addIncident: (incident: GeneratorIncident) => void;
  removeIncident: (incidentId: string) => boolean;
  activeIncidents: () => readonly GeneratorIncident[];
};

export type CreateGeneratorOptions = {
  catalog: GeneratorCatalog;
  trafficWeights: MerchantTrafficWeights;
  random?: SeededRandom;
};

export type TransactionSink = (event: ReturnType<typeof generateTransaction>) => Promise<void> | void;

export function createGenerator(options: CreateGeneratorOptions): TransactionGenerator {
  const cells = buildTransactionCells(options.catalog, options.trafficWeights);
  const random = options.random ?? createSeededRandom(Date.now());
  const incidents = new Map<string, GeneratorIncident>();
  let orderSequence = 0;

  return {
    next(at = new Date()) {
      const cell = random.weightedPick(cells.map((cell) => ({ value: cell, weight: cell.trafficWeight })));
      orderSequence += 1;
      return generateTransaction({
        random,
        transactionId: uuidV4(random),
        merchantOrderId: `order-${at.getTime()}-${orderSequence}`,
        createdAt: at.toISOString(),
        cell,
        amountMinor: amountMinorFor(cell, random),
        incidents: [...incidents.values()],
      });
    },
    addIncident(incident) {
      incidents.set(incident.id, incident);
    },
    removeIncident(incidentId) {
      return incidents.delete(incidentId);
    },
    activeIncidents() {
      return [...incidents.values()];
    },
  };
}

export function startGenerator(
  generator: TransactionGenerator,
  sink: TransactionSink,
  options: { baseTps?: number; tickMilliseconds?: number; now?: () => Date } = {},
): { stop: () => void } {
  const baseTps = options.baseTps ?? 60;
  const tickMilliseconds = options.tickMilliseconds ?? 100;
  const now = options.now ?? (() => new Date());
  let carry = 0;
  let running = false;

  const tick = async (): Promise<void> => {
    const at = now();
    // Carry the period's expected volume across ticks so an in-flight tick
    // never loses it outright, but cap the backlog: without a ceiling a slow
    // sink makes `carry` grow without bound and the generator spends the rest
    // of the run draining a queue instead of tracking real time.
    carry = Math.min(
      carry + transactionsPerSecond(at, baseTps) * tickMilliseconds / 1_000,
      MAX_CARRY_EVENTS,
    );
    if (running) return;

    running = true;
    try {
      const eventsToEmit = Math.floor(carry);
      carry -= eventsToEmit;
      // Emitted concurrently, not in an awaited loop: every sink call is a
      // network round trip, so awaiting them one at a time caps throughput at
      // 1/latency (~5 TPS against a cloud Redis) no matter what baseTps says.
      // `generator.next` still runs synchronously in order here, so the seeded
      // random sequence stays reproducible.
      await Promise.all(
        Array.from({ length: eventsToEmit }, async () => {
          // Timestamp per event rather than once per tick: a batch that takes
          // a while to drain must not stamp every event with the instant the
          // tick began.
          const event = generator.next(now());
          try {
            await sink(event);
          } catch (error) {
            // One bad event (e.g. an invalid injected incident) must not take
            // down the whole tick, and must never surface as an unhandled
            // promise rejection that crashes the process mid-demo.
            logger.error({ error }, "dropped one transaction while emitting a tick");
          }
        }),
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch((error: unknown) => {
      logger.error({ error }, "generator tick failed unexpectedly");
    });
  }, tickMilliseconds);
  return { stop: () => clearInterval(timer) };
}

function amountMinorFor(cell: WeightedTransactionCell, random: SeededRandom): number {
  const range: readonly [number, number] = cell.paymentMethod === "PIX" ? [100, 15_000]
    : cell.country === "AR" ? [50_000, 4_000_000]
      : cell.country === "MX" ? [10_000, 250_000]
        : [5_000, 300_000];
  return range[0] + random.int(range[1] - range[0] + 1);
}

function uuidV4(random: SeededRandom): string {
  const bytes = Array.from({ length: 16 }, () => random.int(256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
