import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmedDrop, EvidenceGap, EvidenceObject } from "@control-tower/contracts";
import type { DeclineSource, RollupSource } from "../db/queries.js";
import type { DeclineCode, DeclineRollupRow } from "../diagnose/types.js";
import type { RollupRow } from "./types.js";
import { bucketsToProcess, createScheduler, startScheduler, targetBucket } from "./scheduler.js";

afterEach(() => { vi.useRealTimers(); });

describe("targetBucket", () => {
  it("returns the minute that closed most recently, after the ingest grace window", () => {
    // 14:07:10 with a 10s grace -> 14:07 has just become safe to read, so the
    // last fully closed bucket is 14:06.
    expect(targetBucket(new Date("2026-08-30T14:07:10.000Z"))).toBe("2026-08-30T14:06:00.000Z");
  });

  it("still points at the previous bucket inside the grace window", () => {
    // 14:07:05 is within the grace, so 14:07 is not trusted yet: stay on 14:05.
    expect(targetBucket(new Date("2026-08-30T14:07:05.000Z"))).toBe("2026-08-30T14:05:00.000Z");
  });
});

describe("bucketsToProcess", () => {
  it("processes only the latest bucket on a cold start", () => {
    expect(bucketsToProcess(null, "2026-08-30T14:06:00.000Z")).toEqual(["2026-08-30T14:06:00.000Z"]);
  });

  it("returns nothing when the target was already processed", () => {
    expect(bucketsToProcess("2026-08-30T14:06:00.000Z", "2026-08-30T14:06:00.000Z")).toEqual([]);
  });

  it("returns nothing when the target is older than the cursor", () => {
    expect(bucketsToProcess("2026-08-30T14:06:00.000Z", "2026-08-30T14:05:00.000Z")).toEqual([]);
  });

  it("catches up over skipped buckets, in order", () => {
    expect(bucketsToProcess("2026-08-30T14:03:00.000Z", "2026-08-30T14:06:00.000Z")).toEqual([
      "2026-08-30T14:04:00.000Z",
      "2026-08-30T14:05:00.000Z",
      "2026-08-30T14:06:00.000Z",
    ]);
  });

  it("caps catch-up and keeps the most recent buckets", () => {
    const buckets = bucketsToProcess("2026-08-30T10:00:00.000Z", "2026-08-30T14:06:00.000Z", 3);

    expect(buckets).toEqual([
      "2026-08-30T14:04:00.000Z",
      "2026-08-30T14:05:00.000Z",
      "2026-08-30T14:06:00.000Z",
    ]);
  });
});

function healthyRows(bucket: string): RollupRow[] {
  return [{
    bucket, merchantId: "BR_STORE_01", providerId: "adyen", country: "BR",
    paymentMethod: "CARD", issuerId: "itau", attempts: 100, approved: 95,
    amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950,
  }];
}

const noDeclines: DeclineSource = {
  getWindowDeclines: async () => [],
  getHistory: async () => [],
};

function deps(overrides: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  const results: Array<{
    bucket: string;
    signals: ConfirmedDrop[];
    evidenceGaps: EvidenceGap[];
    evidence: EvidenceObject[];
  }> = [];
  const source: RollupSource = {
    getWindowRollups: async (bucket) => healthyRows(bucket),
    getHistory: async () => [],
  };
  const base = {
    source,
    declineSource: noDeclines,
    loadMerchants: async () => [{ merchantId: "BR_STORE_01", expectedConversion: 0.95, minMaterialDropPp: 3 }],
    loadCoverage: async () => [{ providerId: "adyen", country: "BR", paymentMethod: "CARD" }],
    loadDeclineCatalog: async () => [] as DeclineCode[],
    onResult: (result: {
      bucket: string;
      signals: ConfirmedDrop[];
      evidenceGaps: EvidenceGap[];
      evidence: EvidenceObject[];
    }) => {
      results.push(result);
    },
    now: () => new Date("2026-08-30T14:07:10.000Z"),
    ...overrides,
  };
  return { deps: base, results };
}

describe("createScheduler", () => {
  it("processes the closed bucket and reports it in the status", async () => {
    const { deps: d, results } = deps();
    const scheduler = createScheduler(d);

    await scheduler.runOnce();

    expect(results.map((r) => r.bucket)).toEqual(["2026-08-30T14:06:00.000Z"]);
    expect(scheduler.getStatus().lastProcessedBucket).toBe("2026-08-30T14:06:00.000Z");
    expect(scheduler.getStatus().lastError).toBeNull();
  });

  it("does not reprocess the same bucket on a second run", async () => {
    const { deps: d, results } = deps();
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    await scheduler.runOnce();

    expect(results).toHaveLength(1);
  });

  it("records the error and does not advance the cursor when a tick fails", async () => {
    const { deps: d, results } = deps({
      source: {
        getWindowRollups: async () => { throw new Error("connection lost"); },
        getHistory: async () => [],
      },
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();

    expect(results).toEqual([]);
    expect(scheduler.getStatus().lastProcessedBucket).toBeNull();
    expect(scheduler.getStatus().lastError).toContain("connection lost");
  });

  it("retries the failed bucket on the next run once the source recovers", async () => {
    let shouldFail = true;
    const { deps: d, results } = deps({
      source: {
        getWindowRollups: async (bucket) => {
          if (shouldFail) throw new Error("connection lost");
          return healthyRows(bucket);
        },
        getHistory: async () => [],
      },
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    shouldFail = false;
    await scheduler.runOnce();

    expect(results.map((r) => r.bucket)).toEqual(["2026-08-30T14:06:00.000Z"]);
    expect(scheduler.getStatus().lastError).toBeNull();
  });

  it("reports the bucket lag in minutes", async () => {
    const { deps: d } = deps();
    const scheduler = createScheduler(d);

    await scheduler.runOnce();

    // Processed 14:06 while "now" is 14:07:10 — one whole minute behind.
    expect(scheduler.getStatus().bucketLagMinutes).toBe(1);
  });

  it("requests exactly the configured history window", async () => {
    const requested: Array<[string, string]> = [];
    const { deps: d } = deps({
      source: {
        getWindowRollups: async (bucket) => healthyRows(bucket),
        getHistory: async (from, to) => { requested.push([from, to]); return []; },
      },
    });

    await createScheduler(d).runOnce();

    // ONSET_LOOKBACK_MIN is 120: [bucket - 120min, bucket).
    expect(requested).toEqual([["2026-08-30T12:06:00.000Z", "2026-08-30T14:06:00.000Z"]]);
  });
});

describe("startScheduler", () => {
  it("does not start a second tick while the previous one is still in flight", async () => {
    vi.useFakeTimers();
    let entries = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps: d } = deps({
      source: {
        getWindowRollups: async (bucket) => {
          entries += 1;
          await gate;
          return healthyRows(bucket);
        },
        getHistory: async () => [],
      },
    });

    const handle = startScheduler(d, 1000);
    // Two full intervals pass while the first tick's getWindowRollups is
    // still hanging on `gate`: a reentrant scheduler would have entered the
    // source three times (once per tick boundary crossed).
    await vi.advanceTimersByTimeAsync(2500);
    expect(entries).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
  });
});

describe("createScheduler persistence across ticks", () => {
  function droppedRows(bucket: string): RollupRow[] {
    // A single cell, well below the merchant's 0.95 expected conversion and
    // comfortably above MIN_VOLUME (30) — the absolute trigger alone
    // confirms it, with no sibling cells to also fire the cross-sectional
    // path, so exactly one signal is expected per confirmed tick.
    return [{
      bucket, merchantId: "BR_STORE_01", providerId: "adyen", country: "BR",
      paymentMethod: "CARD", issuerId: "itau", attempts: 100, approved: 20,
      amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 200,
    }];
  }

  it("threads PersistenceState across ticks so a drop confirms only on the third window", async () => {
    let clock = new Date("2026-08-30T14:07:10.000Z");
    const { deps: d, results } = deps({
      source: {
        getWindowRollups: async (bucket) => droppedRows(bucket),
        getHistory: async () => [],
      },
      now: () => clock,
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    expect(results[0]!.signals).toEqual([]);

    clock = new Date(clock.getTime() + 60_000);
    await scheduler.runOnce();
    expect(results[1]!.signals).toEqual([]);

    clock = new Date(clock.getTime() + 60_000);
    await scheduler.runOnce();
    expect(results[2]!.signals).toHaveLength(1);
    expect(results[2]!.signals[0]).toMatchObject({
      consecutiveWindows: 3,
      dimensions: { merchantId: "BR_STORE_01", country: "BR" },
    });
  });
});

describe("createScheduler diagnose wiring", () => {
  function droppedRows(bucket: string): RollupRow[] {
    return [{
      bucket, merchantId: "BR_STORE_01", providerId: "adyen", country: "BR",
      paymentMethod: "CARD", issuerId: "itau", attempts: 100, approved: 20,
      amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 200,
    }];
  }

  it("stays silent on the two monitoring ticks that precede confirmation", async () => {
    let clock = new Date("2026-08-30T14:07:10.000Z");
    const { deps: d, results } = deps({
      source: { getWindowRollups: async (bucket) => droppedRows(bucket), getHistory: async () => [] },
      now: () => clock,
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    clock = new Date(clock.getTime() + 60_000);
    await scheduler.runOnce();

    expect(results[0]!.evidence).toEqual([]);
    expect(results[1]!.evidence).toEqual([]);
  });

  it("diagnoses the confirmed signal into evidence, through the deterministic path", async () => {
    let clock = new Date("2026-08-30T14:07:10.000Z");
    const { deps: d, results } = deps({
      source: { getWindowRollups: async (bucket) => droppedRows(bucket), getHistory: async () => [] },
      now: () => clock,
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    clock = new Date(clock.getTime() + 60_000);
    await scheduler.runOnce();
    clock = new Date(clock.getTime() + 60_000);
    await scheduler.runOnce();

    expect(results[2]!.evidence).toHaveLength(1);
    expect(results[2]!.evidence[0]).toMatchObject({
      windowBucket: "2026-08-30T14:08:00.000Z",
      diagnosisSource: "beam_search",
      dimensions: { merchantId: "BR_STORE_01", country: "BR" },
    });
  });

  it("requests the current-window and temporal-reference decline ranges", async () => {
    const requested: Array<[string, string]> = [];
    let clock = new Date("2026-08-30T14:07:10.000Z");
    const { deps: d, results } = deps({
      source: { getWindowRollups: async (bucket) => droppedRows(bucket), getHistory: async () => [] },
      declineSource: {
        getWindowDeclines: async () => [] as DeclineRollupRow[],
        getHistory: async (from, to) => { requested.push([from, to]); return []; },
      },
      now: () => clock,
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    clock = new Date(clock.getTime() + 60_000);
    await scheduler.runOnce();
    clock = new Date(clock.getTime() + 60_000);
    await scheduler.runOnce();

    expect(results[2]!.evidence).toHaveLength(1);
    // Current window: 15 minutes ending at (and including) the confirmed
    // bucket, 14:08. Reference window: the 6 hours immediately before that,
    // never overlapping — a reference contaminated by the anomaly it
    // measures against would not be a baseline.
    expect(requested).toContainEqual([
      "2026-08-30T13:54:00.000Z",
      "2026-08-30T14:09:00.000Z",
    ]);
    expect(requested).toContainEqual([
      "2026-08-30T07:54:00.000Z",
      "2026-08-30T13:54:00.000Z",
    ]);
  });
});
