import { inArray, lt } from "drizzle-orm";
import { db } from "../db/client";
import { transactions } from "../db/schema";
import { createLogger } from "../logging.js";

const logger = createLogger("transactions-retention");

// Nothing in the app reads the `transactions` table — the detector, the
// diagnosis and the API all run off rollup_minute / rollup_declines_minute.
// The rows exist for one reason: insert-transactions dedups on
// transaction_id, and process-batch feeds the rollups only the ids that
// INSERT actually wrote, so a batch redelivered by XAUTOCLAIM (or by the
// consumer's own retries) cannot double-count. That makes the retention
// window the dedup window, which is why the default is hours and not minutes:
// it has to dwarf any redelivery, while still bounding the volume. At the
// generator's ~24 tx/s average, 3 hours is ~260k rows instead of ~2M/day.
const DEFAULT_RETENTION_MINUTES = 180;
const DEFAULT_INTERVAL_MINUTES = 10;
// One prune run deletes at most BATCH_SIZE * MAX_BATCHES rows. The cap is the
// point: the first run after this ships meets a table with millions of stale
// rows, and a single unbounded DELETE would write a WAL segment large enough
// to be its own disk incident. Capped runs drain the backlog across ticks.
const BATCH_SIZE = 5_000;
const MAX_BATCHES_PER_RUN = 20;

export type BatchDeleter = (cutoff: Date, limit: number) => Promise<number>;

export type RetentionConfig = {
  enabled: boolean;
  retentionMs: number;
  intervalMs: number;
};

function readMinutes(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`${key} must be a non-negative number of minutes, got ${JSON.stringify(raw)}`);
  }
  return minutes;
}

export function loadRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): RetentionConfig {
  const retentionMinutes = readMinutes(env, "TRANSACTIONS_RETENTION_MINUTES", DEFAULT_RETENTION_MINUTES);
  const intervalMinutes = readMinutes(env, "TRANSACTIONS_RETENTION_INTERVAL_MINUTES", DEFAULT_INTERVAL_MINUTES);
  return {
    // 0 is the operator switch: keep every transaction, accept the growth.
    enabled: retentionMinutes > 0,
    retentionMs: retentionMinutes * 60_000,
    intervalMs: Math.max(intervalMinutes, 1) * 60_000,
  };
}

// Deletes by primary key off a LIMITed subquery rather than
// `DELETE ... WHERE created_at < cutoff`: the latter is one statement holding
// one lock for however many million rows match.
export const deleteBatch: BatchDeleter = async (cutoff, limit) => {
  const doomed = db
    .select({ transactionId: transactions.transactionId })
    .from(transactions)
    .where(lt(transactions.createdAt, cutoff))
    .limit(limit);

  const removed = await db
    .delete(transactions)
    .where(inArray(transactions.transactionId, doomed))
    .returning({ transactionId: transactions.transactionId });

  return removed.length;
};

export type PruneOptions = {
  deleteBatch: BatchDeleter;
  retentionMs: number;
  now?: () => Date;
  batchSize?: number;
  maxBatches?: number;
};

export async function pruneOnce({
  deleteBatch: deleter,
  retentionMs,
  now = () => new Date(),
  batchSize = BATCH_SIZE,
  maxBatches = MAX_BATCHES_PER_RUN,
}: PruneOptions): Promise<{ deleted: number; caughtUp: boolean }> {
  // Frozen before the loop: a cutoff recomputed per batch would keep sliding
  // forward and turn a bounded catch-up into an open-ended one.
  const cutoff = new Date(now().getTime() - retentionMs);
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const removed = await deleter(cutoff, batchSize);
    deleted += removed;
    // A short batch means the subquery ran out of rows older than the cutoff.
    if (removed < batchSize) return { deleted, caughtUp: true };
  }

  return { deleted, caughtUp: false };
}

export type RetentionHandle = {
  runOnce(): Promise<{ deleted: number; caughtUp: boolean }>;
  stop(): void;
};

export function startRetention(
  config: RetentionConfig = loadRetentionConfig(),
  deleter: BatchDeleter = deleteBatch,
): RetentionHandle | null {
  if (!config.enabled) {
    logger.warn("transactions retention is off — the table grows without bound");
    return null;
  }

  const runOnce = () => pruneOnce({ deleteBatch: deleter, retentionMs: config.retentionMs });

  let running = false;
  const timer = setInterval(() => {
    // Same reentrancy guard as the detector scheduler: a slow prune must not
    // stack a second one on top of it, both deleting against the same cutoff.
    if (running) {
      logger.warn("skipped a retention run because the previous one is still in flight");
      return;
    }
    running = true;
    runOnce()
      .then(({ deleted, caughtUp }) => {
        if (deleted > 0) logger.info({ deleted, caughtUp }, "pruned transactions past the retention window");
      })
      .catch((error: unknown) => logger.error({ error }, "transactions retention run failed"))
      .finally(() => {
        running = false;
      });
  }, config.intervalMs);
  // The prune is housekeeping: it must never be the reason the process stays up.
  timer.unref();

  return { runOnce, stop: () => clearInterval(timer) };
}
