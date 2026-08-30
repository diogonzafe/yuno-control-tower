import type { EvidenceObject } from "@control-tower/contracts";
import { describe, expect, it } from "vitest";
import { createEvidenceStore } from "./evidence-store.js";

function evidence(bucketMinute: number): EvidenceObject {
  const bucket = `2026-08-30T14:${String(bucketMinute).padStart(2, "0")}:00.000Z`;
  return {
    fingerprint: `country=BR|merchantId=BR_STORE_01|providerId=adyen#05`,
    dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
    observedRate: 0.41, expectedRate: 0.95, expectedSource: "cross_sectional", deltaPp: 3,
    ci: { low: 0.36, high: 0.46, level: 0.95 }, attempts: 420, approved: 172,
    windowBucket: bucket, windowUsed: "1m", consecutiveWindows: 3,
    startedAt: bucket, startedAtExact: true,
    declineMix: [], dominantDecline: "05", suppressedEchoes: [],
    lostApprovals: 244, costUsdMinor: 24_400, costUsdPerMin: 8_133,
    costLocal: { BRL: 122_000 }, priorityScore: 8_133,
    diagnosisSource: "beam_search", investigationTrail: [],
  };
}

describe("createEvidenceStore", () => {
  it("returns nothing when empty", () => {
    expect(createEvidenceStore().recent()).toEqual([]);
  });

  it("returns the newest evidence first", () => {
    const store = createEvidenceStore();
    store.add([evidence(1)]);
    store.add([evidence(2)]);

    expect(store.recent().map((e) => e.windowBucket)).toEqual([
      "2026-08-30T14:02:00.000Z",
      "2026-08-30T14:01:00.000Z",
    ]);
  });

  it("drops the oldest entries past the cap", () => {
    const store = createEvidenceStore(3);
    store.add([evidence(1), evidence(2), evidence(3), evidence(4)]);

    const buckets = store.recent().map((e) => e.windowBucket);
    expect(buckets).toHaveLength(3);
    expect(buckets).not.toContain("2026-08-30T14:01:00.000Z");
  });

  it("honours the limit argument", () => {
    const store = createEvidenceStore();
    store.add([evidence(1), evidence(2), evidence(3)]);

    expect(store.recent(2)).toHaveLength(2);
  });

  it("ignores empty batches", () => {
    const store = createEvidenceStore();
    store.add([]);

    expect(store.recent()).toEqual([]);
  });
});
