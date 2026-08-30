import { describe, expect, test } from "vitest";
import { fullCoverage } from "../detect/fixtures.js";
import { cellKey } from "./beam-search.js";
import { BR_ROOT, brFullGrid, brTwoIncidentGrid } from "./fixtures.js";
import { peel } from "./peeling.js";

describe("peel", () => {
  test("separates two simultaneous causes under the same root", () => {
    const peels = peel(brTwoIncidentGrid(), BR_ROOT, 0.9, 3, fullCoverage());

    expect(peels.map((p) => cellKey(p.causal.cell))).toEqual([
      "country=BR|issuerId=itau|merchantId=BR_STORE_01|paymentMethod=CARD|providerId=adyen",
      "country=BR|issuerId=nubank|merchantId=BR_STORE_01|paymentMethod=CARD|providerId=stripe",
    ]);
  });

  test("stops as soon as the residual deficit is no longer material", () => {
    expect(peel(brFullGrid(), BR_ROOT, 0.9, 3, fullCoverage())).toHaveLength(1);
  });

  test("suppresses the provider node as an echo of the causal cell", () => {
    const [first] = peel(brFullGrid(), BR_ROOT, 0.9, 3, fullCoverage());

    expect(first!.suppressedEchoes.map((echo) => cellKey(echo.cell))).toContain(
      "country=BR|merchantId=BR_STORE_01|providerId=adyen",
    );
  });

  test("carries the two rates that clear an echo: down now, healthy once the cause is carved out", () => {
    const [first] = peel(brFullGrid(), BR_ROOT, 0.9, 3, fullCoverage());

    const adyen = first!.suppressedEchoes.find(
      (echo) => cellKey(echo.cell) === "country=BR|merchantId=BR_STORE_01|providerId=adyen",
    );

    expect(adyen!.observedRate).toBeCloseTo(316 / 600, 5);
    expect(adyen!.residualRate).toBeCloseTo(286 / 300, 5);
  });
});
