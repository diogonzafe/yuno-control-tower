import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { EvidenceObject } from "@control-tower/contracts";
import type { IncidentRow } from "@control-tower/app";
import { EvidencePanel } from "./evidence-panel";

function render(confidence: EvidenceObject["confidence"]) {
  const evidence: EvidenceObject = {
    fingerprint: "country=BR|merchantId=BR_STORE_01",
    dimensions: { merchantId: "BR_STORE_01", country: "BR" },
    observedRate: 0.76,
    expectedRate: 0.89,
    expectedSource: "cross_sectional",
    deltaPp: 3,
    ci: { low: 0.69, high: 0.82, level: 0.95 },
    attempts: 188,
    approved: 143,
    windowBucket: "2026-08-30T14:06:00.000Z",
    windowUsed: "1m",
    consecutiveWindows: 2,
    startedAt: "2026-08-30T14:03:00.000Z",
    startedAtExact: true,
    declineMix: [],
    dominantDecline: null,
    suppressedEchoes: [],
    lostApprovals: 14,
    costUsdMinor: 194_740,
    costUsdPerMin: 194_740,
    costLocal: { BRL: 1_081_878 },
    priorityScore: 194_740,
    diagnosisSource: "beam_search",
    confidence,
    investigationTrail: [],
  };
  const incident: IncidentRow = {
    incidentId: "incident-1",
    fingerprint: evidence.fingerprint,
    status: "open",
    startedAt: evidence.startedAt,
    detectedAt: "2026-08-30T14:06:00.000Z",
    resolvedAt: null,
    costUsdPerMin: 194_740,
    evidence,
  };
  return renderToStaticMarkup(<EvidencePanel incident={incident} catalog={null} audience="operations" />);
}

describe("EvidencePanel", () => {
  // A card that stopped at the merchant root looks like any other until the
  // panel explains that nothing separated from its siblings.
  test("explains an un-isolated cause instead of leaving it implied", () => {
    const html = render("INCONCLUSIVE");
    expect(html).toContain("Cause not isolated");
    expect(html).toContain("no child slice separated from its siblings");
  });

  test("stays out of the way when the cause was isolated", () => {
    expect(render("CONFIRMED")).not.toContain("Cause not isolated");
  });

  test("stays out of the way for evidence written before the verdict existed", () => {
    expect(render(undefined)).not.toContain("Cause not isolated");
  });
});
