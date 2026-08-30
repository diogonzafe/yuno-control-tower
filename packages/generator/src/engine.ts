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
    if (running) return;
    running = true;
    try {
      const at = now();
      carry += transactionsPerSecond(at, baseTps) * tickMilliseconds / 1_000;
      const eventsToEmit = Math.floor(carry);
      carry -= eventsToEmit;
      for (let index = 0; index < eventsToEmit; index += 1) {
        await sink(generator.next(at));
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, tickMilliseconds);
  return { stop: () => clearInterval(timer) };
}

function amountMinorFor(cell: WeightedTransactionCell, random: SeededRandom): number {
  const range = cell.paymentMethod === "PIX" ? [100, 15_000]
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
