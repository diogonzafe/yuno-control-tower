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
    // Accumulate the period's expected volume before checking reentrancy, so
    // an in-flight tick (e.g. still awaiting a slow XADD) never loses volume
    // outright — it stays in `carry` and is emitted on the next free tick,
    // keeping the generator at the configured ~60 TPS instead of silently
    // under-delivering under any I/O latency.
    carry += transactionsPerSecond(at, baseTps) * tickMilliseconds / 1_000;
    if (running) return;

    running = true;
    try {
      const eventsToEmit = Math.floor(carry);
      carry -= eventsToEmit;
      // Fire the batch concurrently rather than awaiting each sink call in
      // turn. Sequential awaiting made one tick's wall-clock cost scale with
      // eventsToEmit × sink-latency: against a low-latency local Redis that
      // stays under the 100ms tick budget, but against a higher-latency
      // remote Redis it doesn't, so ticks start overlapping in intent (more
      // carry accumulates while one is still draining), each batch grows,
      // and the generator falls permanently behind real time instead of
      // recovering. Not awaiting keeps a tick's own cost close to O(1).
      for (let index = 0; index < eventsToEmit; index += 1) {
        Promise.resolve(sink(generator.next(at))).catch((error: unknown) => {
          // One bad event (e.g. an invalid injected incident) must not take
          // down the whole tick, and must never surface as an unhandled
          // promise rejection that crashes the process mid-demo.
          logger.error({ error }, "dropped one transaction while emitting a tick");
        });
      }
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
