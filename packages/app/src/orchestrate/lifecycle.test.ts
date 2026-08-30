import { describe, expect, it } from "vitest";
import type { EvidenceGap } from "@control-tower/contracts";
import { planTransitions, type ActiveIncident } from "./lifecycle";

const BUCKET = "2026-08-30T14:10:00.000Z";
const CELL = {
  merchantId: "BR_STORE_01",
  providerId: "adyen",
  country: "BR",
  paymentMethod: "CARD",
  issuerId: "itau",
};

function active(incidentId: string, detectedAt: string, dimensions = CELL): ActiveIncident {
  return { incidentId, detectedAt, dimensions };
}

function gap(dimensions: Record<string, string | undefined>): EvidenceGap {
  return {
    dimensions: dimensions as EvidenceGap["dimensions"],
    windowBucket: BUCKET,
    attempts: 4,
    reason: "INSUFFICIENT_EVIDENCE",
  };
}

describe("lifecycle transitions", () => {
  it("leaves an incident reconfirmed in this bucket alone", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", BUCKET)],
      evidenceGaps: [],
    });
    expect(result).toEqual({ resolve: [], inconclusive: [] });
  });

  it("does not resolve after a single quiet window", () => {
    // One quiet minute is noise, not recovery. Resolving here would close the
    // incident and reopen it next tick as a brand-new one, which is the
    // flapping the state machine exists to prevent.
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:09:00.000Z")],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual([]);
  });

  it("does not resolve after two quiet windows", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:08:00.000Z")],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual([]);
  });

  it("resolves after three quiet windows", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual(["a"]);
    expect(result.inconclusive).toEqual([]);
  });

  it("marks a quiet incident inconclusive when its cell lost volume", () => {
    // The cell went below MIN_VOLUME. The system cannot assert recovery, so it
    // admits the evidence is insufficient (spec.md §5) instead of resolving.
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [gap(CELL)],
    });
    expect(result.resolve).toEqual([]);
    expect(result.inconclusive).toEqual(["a"]);
  });

  it("does not confuse a gap on a different cell with this incident", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [gap({ ...CELL, providerId: "stripe" })],
    });
    expect(result.resolve).toEqual(["a"]);
    expect(result.inconclusive).toEqual([]);
  });

  it("treats a gap on a broader cell as a different cell", () => {
    // The incident is pinned to five dimensions; the gap fixes three. They are
    // not the same cell, so the gap must not silence this incident.
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [gap({ merchantId: "BR_STORE_01", providerId: "adyen", country: "BR" })],
    });
    expect(result.inconclusive).toEqual([]);
  });

  it("separates two simultaneous incidents on different cells", () => {
    // spec.md §4 criterion 5: two incidents at once stay two incidents.
    const other = { ...CELL, merchantId: "MX_STORE_01", country: "MX", issuerId: "banorte" };
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z"), active("b", BUCKET, other)],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual(["a"]);
  });
});
