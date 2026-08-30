import { describe, expect, it } from "vitest";
import { CellState, ConfirmedDrop, EvidenceGap, EvidenceObject } from "@control-tower/contracts";

const validSignal = {
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
  windowBucket: "2026-08-30T14:06:00.000Z", observedRate: 0.41, expectedRate: 0.95,
  expectedSource: "cross_sectional", deltaPp: 3, ciLow: 0.36, ciHigh: 0.46,
  ciLevel: 0.95, attempts: 420, approved: 172, windowUsed: "1m",
  startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true, consecutiveWindows: 3,
};

const validEvidence = {
  fingerprint: "country=BR|providerId=adyen",
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen", issuerId: "itau" },
  observedRate: 0.12, expectedRate: 0.7, expectedSource: "cross_sectional", deltaPp: 3,
  ci: { low: 0.08, high: 0.17, level: 0.95 }, attempts: 420, approved: 50,
  windowBucket: "2026-08-30T14:06:00.000Z", windowUsed: "1m", consecutiveWindows: 3,
  startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true,
  declineMix: [{ code: "05", family: "issuer", observedShare: 0.78, baselineShare: 0.32, count: 289 }],
  dominantDecline: "05",
  suppressedEchoes: [{ dimensions: { country: "BR" }, observedRate: 0.58, residualRate: 0.66 }],
  lostApprovals: 244, costUsdMinor: 380_000, costUsdPerMin: 3_800,
  costLocal: { BRL: 1_284_00 }, priorityScore: 91.4,
  diagnosisSource: "beam_search", investigationTrail: [],
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

  it("accepts a well-formed EvidenceObject on the deterministic path", () => {
    expect(() => EvidenceObject.parse(validEvidence)).not.toThrow();
  });

  it("accepts the agent path, carrying an investigation trail", () => {
    const withTrail = {
      ...validEvidence, diagnosisSource: "agent",
      investigationTrail: [{
        stepNo: 1,
        toolCallId: "run-1:1:query_conversion_slice",
        toolName: "query_conversion_slice",
        toolArgs: { splitBy: "country" },
        toolResult: { BR: 0.38 },
        status: "completed",
        errorCode: null,
        decisionTag: "DRILL_DOWN",
        decisionSummary: "Compared countries for the provider slice.",
        hypothesis: { dimension: "country", value: "BR" },
        evidenceStepNos: [],
        createdAt: "2026-08-30T14:06:00.000Z",
        completedAt: "2026-08-30T14:06:01.000Z",
      }],
    };
    expect(() => EvidenceObject.parse(withTrail)).not.toThrow();
  });

  it("rejects a diagnosisSource outside the two known paths", () => {
    expect(() => EvidenceObject.parse({ ...validEvidence, diagnosisSource: "vibes" })).toThrow();
  });

  it("rejects an EvidenceObject missing the cost the narrator must quote", () => {
    const { costUsdPerMin, ...bad } = validEvidence;
    expect(() => EvidenceObject.parse(bad)).toThrow();
  });
});
