import type { ConfirmedDrop, EvidenceGap, EvidenceObject } from "@control-tower/contracts";
import { createLogger } from "../logging.js";
import type { DeclineSource, RollupSource } from "../db/queries.js";
import { DECLINE_CURRENT_LOOKBACK_MIN, DECLINE_HISTORY_LOOKBACK_MIN } from "../diagnose/constants.js";
import { buildEvidence } from "../diagnose/evidence.js";
import { runDiagnosis } from "../diagnose/run.js";
import type { DeclineCode } from "../diagnose/types.js";
import { ONSET_LOOKBACK_MIN } from "./constants.js";
import { runDetectionTick } from "./tick.js";
import type { PersistenceState } from "./persistence.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "./types.js";

const logger = createLogger("detector-scheduler");

const MINUTE_MS = 60_000;
// Gives the ingest consumer time to finish writing the minute that just
// closed. Costs 10s of detection latency, irrelevant against the 3 consecutive
// windows the persistence rule already requires.
const INGEST_GRACE_MS = 10_000;
const CATCH_UP_CAP = 10;
const TICK_INTERVAL_MS = 60_000;

export type SchedulerDeps = {
  source: RollupSource;
  declineSource: DeclineSource;
  loadMerchants: () => Promise<MerchantConfig[]>;
  loadCoverage: () => Promise<RoutingCoverage>;
  loadDeclineCatalog: () => Promise<DeclineCode[]>;
  emitDeterministicEvidence?: boolean;
  // Overrides constants.ts's DD11/DD14-locked default (3). Only meant for a
  // deployment that deliberately trades detection confidence for latency
  // (e.g. a live demo); the locked default applies whenever this is unset.
  persistenceWindows?: number;
  onResult: (result: {
    bucket: string;
    signals: ConfirmedDrop[];
    evidenceGaps: EvidenceGap[];
    evidence: EvidenceObject[];
  }) => void;
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

// The deterministic path: a confirmed signal is diagnosed and turned into
// evidence in the same tick, with no agent involved (diagnosisSource always
// "beam_search"). Skipped when nothing confirmed, so a quiet minute costs
// no extra decline queries.
async function diagnose(
  deps: SchedulerDeps,
  bucket: string,
  signals: ConfirmedDrop[],
  rollups: RollupRow[],
  merchants: MerchantConfig[],
  coverage: RoutingCoverage,
  catalog: DeclineCode[],
): Promise<EvidenceObject[]> {
  if (signals.length === 0) return [];

  // Current window: wide enough for declineMixShift's own widest window.
  // Reference window: immediately before that, never overlapping it — a
  // reference contaminated by the anomaly it measures against would not be
  // a baseline (diagnose/constants.ts).
  const currentFrom = shift(bucket, -(DECLINE_CURRENT_LOOKBACK_MIN - 1));
  const currentTo = shift(bucket, 1);
  const referenceFrom = shift(currentFrom, -DECLINE_HISTORY_LOOKBACK_MIN);

  const [declines, declineHistory] = await Promise.all([
    deps.declineSource.getHistory(currentFrom, currentTo),
    deps.declineSource.getHistory(referenceFrom, currentFrom),
  ]);

  const diagnoses = runDiagnosis({
    signals,
    windowBucket: bucket,
    rollups,
    declines,
    declineHistory,
    merchants,
    coverage,
    catalog,
  });

  return diagnoses.map((diagnosis) =>
    buildEvidence({ diagnosis, rows: rollups, diagnosisSource: "beam_search" }),
  );
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
        const [merchants, coverage, catalog] = await Promise.all([
          deps.loadMerchants(),
          deps.loadCoverage(),
          deps.loadDeclineCatalog(),
        ]);

        for (const bucket of bucketsToProcess(lastProcessedBucket, target)) {
          const [windowRows, history] = await Promise.all([
            deps.source.getWindowRollups(bucket),
            deps.source.getHistory(shift(bucket, -ONSET_LOOKBACK_MIN), bucket),
          ]);

          const output = runDetectionTick({ bucket, windowRows, history, merchants, coverage, prevState: persistence, persistenceWindows: deps.persistenceWindows });
          persistence = output.nextState;
          lastProcessedBucket = bucket;

          const evidence = deps.emitDeterministicEvidence === false
            ? []
            : await diagnose(
              deps,
              bucket,
              output.signals,
              [...history, ...windowRows],
              merchants,
              coverage,
              catalog,
            );
          deps.onResult({ bucket, signals: output.signals, evidenceGaps: output.evidenceGaps, evidence });
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
  let running = false;
  const timer = setInterval(() => {
    // Reentrancy guard: a tick that outruns the interval (slow DB, big
    // catch-up) must not start a second `runOnce` against the same
    // `lastProcessedBucket`/`persistence` snapshot — that would double-count
    // the persistence streak and double-broadcast the same signal over SSE.
    // `runOnce` itself stays unguarded; the tests drive it directly.
    if (running) {
      logger.warn("skipped a scheduler tick because the previous one is still in flight");
      return;
    }
    running = true;
    scheduler.runOnce()
      .catch((error: unknown) => logger.error({ error }, "scheduler tick rejected unexpectedly"))
      .finally(() => { running = false; });
  }, intervalMs);

  return {
    runOnce: () => scheduler.runOnce(),
    getStatus: () => scheduler.getStatus(),
    stop: () => clearInterval(timer),
  };
}
