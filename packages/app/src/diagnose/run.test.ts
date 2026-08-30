import { describe, expect, test } from "vitest";
import { fullCoverage } from "../detect/fixtures.js";
import { cellKey } from "./beam-search.js";
import {
  BR_CAUSAL,
  BR_ROOT,
  BUCKET,
  DECLINE_CATALOG,
  DIAGNOSE_MERCHANTS,
  MX_ROOT,
  brFlatDropGrid,
  brFullGrid,
  confirmedDrop,
  declineRow,
  mxIssuerGrid,
} from "./fixtures.js";
import { runDiagnosis } from "./run.js";

const base = {
  windowBucket: BUCKET,
  declines: [],
  declineHistory: [],
  merchants: DIAGNOSE_MERCHANTS,
  coverage: fullCoverage(),
  catalog: DECLINE_CATALOG,
};

describe("runDiagnosis", () => {
  test("separates the two mandatory incidents and ranks them by money per minute", () => {
    const diagnoses = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT), confirmedDrop(MX_ROOT)],
      rollups: [...brFullGrid(), ...mxIssuerGrid()],
    });

    expect(diagnoses.map((d) => cellKey(d.cell))).toEqual([
      "country=BR|issuerId=itau|merchantId=BR_STORE_01|paymentMethod=CARD|providerId=adyen",
      "country=MX|issuerId=bbva_mx|merchantId=MX_STORE_01",
    ]);
    expect(diagnoses[0]!.impact.priorityScore).toBeGreaterThan(diagnoses[1]!.impact.priorityScore);
    expect(diagnoses.every((d) => d.confidence === "CONFIRMED")).toBe(true);
  });

  test("suppresses the correlated provider node instead of raising it as a second incident", () => {
    const diagnoses = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT)],
      rollups: brFullGrid(),
    });

    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]!.suppressedEchoes.map((echo) => cellKey(echo.cell))).toContain(
      "country=BR|merchantId=BR_STORE_01|providerId=adyen",
    );
  });

  test("carries the detection context the evidence object has to report", () => {
    const [diagnosis] = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT)],
      rollups: brFullGrid(),
    });

    expect(diagnosis!.expectedSource).toBe("cross_sectional");
    expect(diagnosis!.deltaPp).toBe(3);
    expect(diagnosis!.windowUsed).toBe("1m");
    expect(diagnosis!.consecutiveWindows).toBe(3);
  });

  test("reports the absolute trigger as the source when no child stands out", () => {
    const [diagnosis] = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT)],
      rollups: brFlatDropGrid(),
    });

    expect(diagnosis!.expectedSource).toBe("absolute");
  });

  test("takes the longest-running confirmation when several signals share a root", () => {
    const [diagnosis] = runDiagnosis({
      ...base,
      signals: [
        { ...confirmedDrop(BR_ROOT), consecutiveWindows: 3 },
        { ...confirmedDrop({ ...BR_ROOT, providerId: "adyen" }), consecutiveWindows: 7 },
      ],
      rollups: brFullGrid(),
    });

    expect(diagnosis!.consecutiveWindows).toBe(7);
  });

  test("admits insufficient evidence when the root is down but no child stands out", () => {
    const diagnoses = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT)],
      rollups: brFlatDropGrid(),
    });

    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]!.confidence).toBe("INCONCLUSIVE");
    expect(cellKey(diagnoses[0]!.cell)).toBe("country=BR|merchantId=BR_STORE_01");
  });

  test("attaches the decline shift and names the issuer as the causal dimension", () => {
    const declines = [
      declineRow({ declineCode: "05", count: 78 }),
      declineRow({ declineCode: "51", count: 20 }),
      declineRow({ declineCode: "91", count: 2 }),
    ];

    const [diagnosis] = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT)],
      rollups: brFullGrid(),
      declines,
    });

    expect(diagnosis!.declineMix!.dominantCode).toBe("05");
    expect(diagnosis!.causalDimension).toBe("issuer");
    expect(cellKey(diagnosis!.cell)).toBe(cellKey(BR_CAUSAL));
  });

  test("reads a provider outage from the spread of code 91", () => {
    const declines = ["itau", "nubank", "bradesco"].map((issuerId) =>
      declineRow({ declineCode: "91", issuerId, count: 40 }),
    );

    const [diagnosis] = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT)],
      rollups: brFullGrid(),
      declines,
    });

    expect(diagnosis!.outageAttribution).toBe("PROVIDER");
    expect(diagnosis!.causalDimension).toBe("provider");
  });
});
