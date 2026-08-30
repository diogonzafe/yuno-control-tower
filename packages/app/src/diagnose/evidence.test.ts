import type { InvestigationStep } from "@control-tower/contracts";
import { describe, expect, test } from "vitest";
import { fullCoverage } from "../detect/fixtures.js";
import {
  BR_ROOT,
  BUCKET,
  DECLINE_CATALOG,
  DIAGNOSE_MERCHANTS,
  MX_ROOT,
  brFullGrid,
  confirmedDrop,
  declineRow,
  mxIssuerGrid,
} from "./fixtures.js";
import { buildEvidence } from "./evidence.js";
import { runDiagnosis, type Diagnosis } from "./run.js";
import type { DeclineRollupRow } from "./types.js";

const NO_DECLINES: DeclineRollupRow[] = [];

const base = {
  windowBucket: BUCKET,
  declines: NO_DECLINES,
  declineHistory: [],
  merchants: DIAGNOSE_MERCHANTS,
  coverage: fullCoverage(),
  catalog: DECLINE_CATALOG,
};

const DECLINES = [
  declineRow({ declineCode: "05", count: 78 }),
  declineRow({ declineCode: "51", count: 20 }),
  declineRow({ declineCode: "91", count: 2 }),
];

function diagnose(rollups = brFullGrid(), declines = base.declines): Diagnosis {
  const [diagnosis] = runDiagnosis({
    ...base,
    signals: [confirmedDrop(BR_ROOT)],
    rollups,
    declines,
  });
  return diagnosis!;
}

function evidenceFor(rollups = brFullGrid(), declines = base.declines) {
  return buildEvidence({
    diagnosis: diagnose(rollups, declines),
    rows: rollups,
    diagnosisSource: "beam_search",
  });
}

describe("buildEvidence", () => {
  test("carries the causal cell and the drop the detector confirmed", () => {
    const evidence = evidenceFor();

    expect(evidence.dimensions).toEqual({
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    });
    expect(evidence.observedRate).toBeCloseTo(0.1, 5);
    expect(evidence.expectedSource).toBe("cross_sectional");
    expect(evidence.consecutiveWindows).toBe(3);
    expect(evidence.ci).toEqual({
      low: expect.any(Number),
      high: expect.any(Number),
      level: 0.95,
    });
  });

  test("fingerprints the cell together with the dominant decline code", () => {
    expect(evidenceFor(brFullGrid(), DECLINES).fingerprint).toBe(
      "country=BR|issuerId=itau|merchantId=BR_STORE_01|paymentMethod=CARD|providerId=adyen#05",
    );
  });

  test("leaves the fingerprint bare when no decline code dominates", () => {
    expect(evidenceFor().fingerprint).toBe(
      "country=BR|issuerId=itau|merchantId=BR_STORE_01|paymentMethod=CARD|providerId=adyen",
    );
  });

  test("gives the two mandatory incidents different fingerprints", () => {
    const rollups = [...brFullGrid(), ...mxIssuerGrid()];
    const diagnoses = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT), confirmedDrop(MX_ROOT)],
      rollups,
    });

    const fingerprints = diagnoses.map(
      (diagnosis) => buildEvidence({ diagnosis, rows: rollups, diagnosisSource: "beam_search" }).fingerprint,
    );

    expect(new Set(fingerprints).size).toBe(2);
  });

  test("renames the mix reference onto the contract's baseline share", () => {
    const evidence = evidenceFor(brFullGrid(), DECLINES);
    const dominant = evidence.declineMix.find((entry) => entry.code === "05");

    expect(evidence.dominantDecline).toBe("05");
    expect(dominant).toEqual({
      code: "05",
      family: "issuer",
      observedShare: 0.78,
      baselineShare: 0.32,
      count: 78,
    });
  });

  test("carries each echo with the residual rate that cleared it", () => {
    const evidence = evidenceFor();

    expect(evidence.suppressedEchoes).toContainEqual({
      dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
      observedRate: 316 / 600,
      residualRate: 286 / 300,
    });
  });

  test("drops an echo the cause swallowed whole — it has no residual to report", () => {
    const diagnosis = diagnose();
    const evidence = buildEvidence({
      diagnosis: {
        ...diagnosis,
        suppressedEchoes: [{ cell: { merchantId: "BR_STORE_01" }, observedRate: 0.5, residualRate: null }],
      },
      rows: brFullGrid(),
      diagnosisSource: "beam_search",
    });

    expect(evidence.suppressedEchoes).toEqual([]);
  });

  test("rounds money per minute to whole minor units", () => {
    const diagnosis = diagnose();
    const evidence = buildEvidence({
      diagnosis: { ...diagnosis, impact: { ...diagnosis.impact, costUsdPerMin: 1234.56 } },
      rows: brFullGrid(),
      diagnosisSource: "beam_search",
    });

    expect(evidence.costUsdPerMin).toBe(1235);
  });

  test("builds the deterministic trail itself when none is supplied", () => {
    const evidence = evidenceFor();

    expect(evidence.diagnosisSource).toBe("beam_search");
    expect(evidence.investigationTrail.map((step) => step.toolName)).toEqual([
      "query_slice",
      "query_slice",
      "query_slice",
      "residual_test",
    ]);
  });

  test("keeps an agent's trail verbatim instead of replacing it", () => {
    const trail: InvestigationStep[] = [
      {
        stepNo: 1,
        actor: "agent",
        toolName: "query_slice",
        toolArgs: { filter: BR_ROOT },
        toolResult: { rate: 0.41 },
        reasoning: "adyen looks isolated, checking its countries",
      },
    ];

    const evidence = buildEvidence({
      diagnosis: diagnose(),
      rows: brFullGrid(),
      diagnosisSource: "agent",
      investigationTrail: trail,
    });

    expect(evidence.investigationTrail).toEqual(trail);
    expect(evidence.diagnosisSource).toBe("agent");
  });
});
