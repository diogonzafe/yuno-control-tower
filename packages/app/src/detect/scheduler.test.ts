import { describe, expect, it } from "vitest";
import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import type { RollupSource } from "../db/queries.js";
import type { RollupRow } from "./types.js";
import { bucketsToProcess, createScheduler, targetBucket } from "./scheduler.js";

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
    amountUsdSum: 1000, approvedUsdSum: 950,
  }];
}

function deps(overrides: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  const results: Array<{ bucket: string; signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[] }> = [];
  const source: RollupSource = {
    getWindowRollups: async (bucket) => healthyRows(bucket),
    getHistory: async () => [],
  };
  const base = {
    source,
    loadMerchants: async () => [{ merchantId: "BR_STORE_01", expectedConversion: 0.95, minMaterialDropPp: 3 }],
    loadCoverage: async () => [{ providerId: "adyen", country: "BR", paymentMethod: "CARD" }],
    onResult: (result: { bucket: string; signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[] }) => { results.push(result); },
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
