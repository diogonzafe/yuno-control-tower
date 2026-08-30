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

    expect(first!.suppressedEchoes.map(cellKey)).toContain(
      "country=BR|merchantId=BR_STORE_01|providerId=adyen",
    );
  });
});
