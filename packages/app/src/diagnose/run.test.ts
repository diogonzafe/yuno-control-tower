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
  brDualCauseWithPixGrid,
  brFullGrid,
  brNoisyHealthyGrid,
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

  // The detector confirms a cell with two-window persistence and a Wilson bound
  // at the granularity that matters; throwing that away because the merchant
  // root no longer reads as material is how the jury's second incident went
  // missing. Here the healthy PIX book dilutes the root to 0.871 against a
  // 0.870 limit once the severe cause is peeled, so the peel stops — while
  // adyen and nubank are already confirmed drops in their own right.
  test("keeps a confirmed signal the peel could not reach", () => {
    const rollups = brDualCauseWithPixGrid();
    const diagnoses = runDiagnosis({
      ...base,
      signals: [
        confirmedDrop({ merchantId: "BR_STORE_01", country: "BR" }),
        confirmedDrop({ merchantId: "BR_STORE_01", country: "BR", providerId: "stripe" }),
        confirmedDrop({ merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" }),
        confirmedDrop({ merchantId: "BR_STORE_01", country: "BR", paymentMethod: "CARD", issuerId: "nubank" }),
      ],
      rollups,
    });

    const cells = diagnoses.map((d) => cellKey(d.cell));
    expect(cells.some((c) => c.includes("stripe") && c.includes("itau"))).toBe(true);
    expect(cells.some((c) => c.includes("adyen") || c.includes("nubank"))).toBe(true);
  });

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

  test("still reports the root-level signal when this tick's own window reads healthy", () => {
    // The signal is a real, persistence-confirmed drop (detect/persistence.ts
    // already required consecutive MATERIAL_DROP windows to produce it), but
    // this specific tick's rollups look fine on their own — ordinary
    // minute-to-minute noise, not a resolution. Before the fix this silently
    // produced zero diagnoses (and therefore no incident) whenever a signal's
    // own tick happened to land on a healthy-looking window.
    const diagnoses = runDiagnosis({
      ...base,
      signals: [confirmedDrop(BR_ROOT)],
      rollups: brNoisyHealthyGrid(),
    });

    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]!.confidence).toBe("INCONCLUSIVE");
    expect(cellKey(diagnoses[0]!.cell)).toBe("country=BR|merchantId=BR_STORE_01");
    // Reports the signal's own validated numbers, not a re-derivation from
    // this window's (healthy-looking) rollups.
    expect(diagnoses[0]!.attempts).toBe(1400);
    expect(diagnoses[0]!.approved).toBe(1078);
    expect(diagnoses[0]!.observedRate).toBe(0.7);
  });

  test("trusts a cross-sectional signal (e.g. + paymentMethod) when no exact root-level one exists", () => {
    // The jury console's broad injections (country + paymentMethod, no
    // merchantId) only ever confirm through crossSectionalSweep's
    // paymentMethod split — a 3-key {merchantId, country, paymentMethod}
    // signal — never through absoluteTrigger's exact 2-key root. Requiring
    // dimensions.length === 2 (the first version of this fix) missed this
    // real case entirely and kept dropping the diagnosis.
    const diagnoses = runDiagnosis({
      ...base,
      signals: [confirmedDrop({ ...BR_ROOT, paymentMethod: "CARD" })],
      rollups: brNoisyHealthyGrid(),
    });

    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]!.confidence).toBe("INCONCLUSIVE");
    expect(cellKey(diagnoses[0]!.cell)).toBe("country=BR|merchantId=BR_STORE_01");
    expect(diagnoses[0]!.observedRate).toBe(0.7);
  });

  test("prefers the fewer-dimension signal when both an exact root and a narrower one confirmed", () => {
    const diagnoses = runDiagnosis({
      ...base,
      signals: [
        { ...confirmedDrop({ ...BR_ROOT, paymentMethod: "CARD" }), observedRate: 0.5 },
        { ...confirmedDrop(BR_ROOT), observedRate: 0.8 },
      ],
      rollups: brNoisyHealthyGrid(),
    });

    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]!.observedRate).toBe(0.8);
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
