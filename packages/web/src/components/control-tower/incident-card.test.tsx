import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { EvidenceObject } from "@control-tower/contracts";
import type { IncidentRow } from "@control-tower/app";
import { IncidentCard } from "./incident-card";

const evidence = (overrides: Partial<EvidenceObject> = {}): EvidenceObject => ({
  fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=stripe",
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "stripe" },
  observedRate: 0.31,
  expectedRate: 0.9,
  expectedSource: "cross_sectional",
  deltaPp: 3,
  ci: { low: 0.26, high: 0.37, level: 0.95 },
  attempts: 400,
  approved: 124,
  windowBucket: "2026-08-30T14:06:00.000Z",
  windowUsed: "1m",
  consecutiveWindows: 2,
  startedAt: "2026-08-30T14:03:00.000Z",
  startedAtExact: true,
  declineMix: [],
  dominantDecline: null,
  suppressedEchoes: [],
  lostApprovals: 236,
  costUsdMinor: 380_000,
  costUsdPerMin: 3_800,
  costLocal: { BRL: 1_284_000 },
  priorityScore: 3_800,
  diagnosisSource: "beam_search",
  investigationTrail: [],
  ...overrides,
});

function render(confidence: EvidenceObject["confidence"]) {
  const incident: IncidentRow = {
    incidentId: "incident-1",
    fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=stripe",
    status: "open",
    startedAt: "2026-08-30T14:03:00.000Z",
    detectedAt: "2026-08-30T14:06:00.000Z",
    resolvedAt: null,
    costUsdPerMin: 3_800,
    evidence: evidence({ confidence }),
  };
  return renderToStaticMarkup(
    <IncidentCard incident={incident} selectedId={null} onSelect={() => {}} catalog={null} />,
  );
}

describe("IncidentCard", () => {
  test("says so when the drill-down isolated a cause", () => {
    const html = render("CONFIRMED");
    expect(html).toContain("Cause isolated");
    expect(html).not.toContain("Cause not isolated");
  });

  // The whole point of the chip: a confirmed drop with no cause behind it used
  // to render identically to a full diagnosis.
  test("says so when it did not", () => {
    expect(render("INCONCLUSIVE")).toContain("Cause not isolated");
  });

  test("claims neither for evidence written before the verdict existed", () => {
    expect(render(undefined)).not.toContain("Cause");
  });
});
