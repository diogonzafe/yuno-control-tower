import { describe, expect, it } from "vitest";
import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import { createSignalStore } from "./signal-store.js";

function signal(bucketMinute: number): ConfirmedDrop {
  const bucket = `2026-08-30T14:${String(bucketMinute).padStart(2, "0")}:00.000Z`;
  return {
    dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
    windowBucket: bucket, observedRate: 0.41, expectedRate: 0.95,
    expectedSource: "cross_sectional", deltaPp: 3, ciLow: 0.36, ciHigh: 0.46,
    ciLevel: 0.95, attempts: 420, approved: 172, windowUsed: "1m",
    startedAt: bucket, startedAtExact: true, consecutiveWindows: 3,
  };
}

function gap(attempts: number): EvidenceGap {
  return {
    dimensions: { merchantId: "MX_STORE_01", country: "MX" },
    windowBucket: "2026-08-30T14:06:00.000Z", attempts, reason: "INSUFFICIENT_EVIDENCE",
  };
}

describe("createSignalStore", () => {
  it("returns nothing when empty", () => {
    const store = createSignalStore();
    expect(store.recentSignals()).toEqual([]);
    expect(store.recentGaps()).toEqual([]);
  });

  it("returns the newest signal first", () => {
    const store = createSignalStore();
    store.addSignals([signal(1)]);
    store.addSignals([signal(2)]);

    expect(store.recentSignals().map((s) => s.windowBucket)).toEqual([
      "2026-08-30T14:02:00.000Z",
      "2026-08-30T14:01:00.000Z",
    ]);
  });

  it("keeps newest-first ordering within a single batch", () => {
    const store = createSignalStore();
    store.addSignals([signal(1), signal(2)]);

    expect(store.recentSignals()[0]!.windowBucket).toBe("2026-08-30T14:02:00.000Z");
  });

  it("drops the oldest entries past the cap", () => {
    const store = createSignalStore(3);
    store.addSignals([signal(1), signal(2), signal(3), signal(4)]);

    const buckets = store.recentSignals().map((s) => s.windowBucket);
    expect(buckets).toHaveLength(3);
    expect(buckets).not.toContain("2026-08-30T14:01:00.000Z");
  });

  it("honours the limit argument", () => {
    const store = createSignalStore();
    store.addSignals([signal(1), signal(2), signal(3)]);

    expect(store.recentSignals(2)).toHaveLength(2);
  });

  it("keeps signals and gaps in separate buffers", () => {
    const store = createSignalStore();
    store.addSignals([signal(1)]);
    store.addGaps([gap(7), gap(8)]);

    expect(store.recentSignals()).toHaveLength(1);
    expect(store.recentGaps()).toHaveLength(2);
    expect(store.recentGaps()[0]!.attempts).toBe(8);
  });

  it("ignores empty batches", () => {
    const store = createSignalStore();
    store.addSignals([]);
    store.addGaps([]);

    expect(store.recentSignals()).toEqual([]);
    expect(store.recentGaps()).toEqual([]);
  });
});
