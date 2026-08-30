import { describe, expect, it } from "vitest";
import { CellState, ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";

const validSignal = {
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
  windowBucket: "2026-08-30T14:06:00.000Z", observedRate: 0.41, expectedRate: 0.95,
  expectedSource: "cross_sectional", deltaPp: 3, ciLow: 0.36, ciHigh: 0.46,
  ciLevel: 0.95, attempts: 420, approved: 172, windowUsed: "1m",
  startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true, consecutiveWindows: 3,
};

describe("contracts", () => {
  it("accepts a well-formed ConfirmedDrop", () => expect(() => ConfirmedDrop.parse(validSignal)).not.toThrow());
  it("rejects a ConfirmedDrop missing ciLow", () => {
    const { ciLow, ...bad } = validSignal;
    expect(() => ConfirmedDrop.parse(bad)).toThrow();
  });
  it("rejects an unknown CellState", () => expect(() => CellState.parse("WOBBLY")).toThrow());
  it("accepts only the EvidenceGap reason literal", () => {
    const gap = { dimensions: { merchantId: "MX_STORE_01", country: "MX" }, windowBucket: "2026-08-30T14:06:00.000Z", attempts: 7, reason: "INSUFFICIENT_EVIDENCE" };
    expect(() => EvidenceGap.parse(gap)).not.toThrow();
    expect(() => EvidenceGap.parse({ ...gap, reason: "OTHER" })).toThrow();
  });
});
