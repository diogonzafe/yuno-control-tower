import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import pino from "pino";
import type { RollupSource } from "../db/queries.js";
import { ONSET_LOOKBACK_MIN } from "./constants.js";
import { runDetectionTick } from "./tick.js";
import type { PersistenceState } from "./persistence.js";
import type { MerchantConfig, RoutingCoverage } from "./types.js";

const logger = pino({ name: "detector-scheduler", level: process.env.VITEST ? "silent" : "info" });

const MINUTE_MS = 60_000;
// Gives the ingest consumer time to finish writing the minute that just
// closed. Costs 10s of detection latency, irrelevant against the 3 consecutive
// windows the persistence rule already requires.
const INGEST_GRACE_MS = 10_000;
const CATCH_UP_CAP = 10;
const TICK_INTERVAL_MS = 60_000;

export type SchedulerDeps = {
  source: RollupSource;
  loadMerchants: () => Promise<MerchantConfig[]>;
  loadCoverage: () => Promise<RoutingCoverage>;
  onResult: (result: { bucket: string; signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[] }) => void;
  now?: () => Date;
};

export type SchedulerStatus = {
  lastTickAt: string | null;
  lastProcessedBucket: string | null;
  bucketLagMinutes: number | null;
  lastError: string | null;
};

export type SchedulerHandle = {
  runOnce(): Promise<void>;
  getStatus(): SchedulerStatus;
  stop(): void;
};

function floorToMinute(date: Date): Date {
  const floored = new Date(date);
  floored.setUTCSeconds(0, 0);
  return floored;
}

function shift(bucket: string, minutes: number): string {
  return new Date(new Date(bucket).getTime() + minutes * MINUTE_MS).toISOString();
}

export function targetBucket(now: Date): string {
  return shift(floorToMinute(new Date(now.getTime() - INGEST_GRACE_MS)).toISOString(), -1);
}

export function bucketsToProcess(lastProcessed: string | null, target: string, cap = CATCH_UP_CAP): string[] {
  if (lastProcessed === null) return [target];
  if (new Date(target) <= new Date(lastProcessed)) return [];

  const buckets: string[] = [];
  for (let bucket = shift(lastProcessed, 1); new Date(bucket) <= new Date(target); bucket = shift(bucket, 1)) {
    buckets.push(bucket);
  }
  // Keeping the most recent buckets means a long outage loses the oldest
  // minutes rather than delaying detection of what is happening now.
  return buckets.slice(-cap);
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const now = deps.now ?? (() => new Date());
  let persistence: PersistenceState = new Map();
  let lastProcessedBucket: string | null = null;
  let lastTickAt: string | null = null;
  let lastError: string | null = null;

  return {
    async runOnce() {
      const at = now();
      lastTickAt = at.toISOString();
      const target = targetBucket(at);

      try {
        const [merchants, coverage] = await Promise.all([deps.loadMerchants(), deps.loadCoverage()]);

        for (const bucket of bucketsToProcess(lastProcessedBucket, target)) {
          const [windowRows, history] = await Promise.all([
            deps.source.getWindowRollups(bucket),
            deps.source.getHistory(shift(bucket, -ONSET_LOOKBACK_MIN), bucket),
          ]);

          const output = runDetectionTick({ bucket, windowRows, history, merchants, coverage, prevState: persistence });
          persistence = output.nextState;
          lastProcessedBucket = bucket;
          deps.onResult({ bucket, signals: output.signals, evidenceGaps: output.evidenceGaps });
        }

        lastError = null;
      } catch (error) {
        // The cursor deliberately stays put: the next tick's catch-up retries
        // this bucket. A persistent failure shows up as a growing
        // bucketLagMinutes on /health rather than as silently skipped minutes.
        lastError = error instanceof Error ? error.message : String(error);
        logger.error({ error, target }, "detection tick failed");
      }
    },
    getStatus() {
      return {
        lastTickAt,
        lastProcessedBucket,
        bucketLagMinutes:
          lastProcessedBucket === null
            ? null
            : Math.floor((floorToMinute(now()).getTime() - new Date(lastProcessedBucket).getTime()) / MINUTE_MS),
        lastError,
      };
    },
    stop() {},
  };
}

export function startScheduler(deps: SchedulerDeps, intervalMs = TICK_INTERVAL_MS): SchedulerHandle {
  const scheduler = createScheduler(deps);
  const timer = setInterval(() => {
    scheduler.runOnce().catch((error: unknown) => logger.error({ error }, "scheduler tick rejected unexpectedly"));
  }, intervalMs);

  return {
    runOnce: () => scheduler.runOnce(),
    getStatus: () => scheduler.getStatus(),
    stop: () => clearInterval(timer),
  };
}
