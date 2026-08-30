import { describe, expect, test } from "vitest";
import { fullCoverage } from "../detect/fixtures.js";
import { beamSearch, cellKey, type Candidate } from "./beam-search.js";
import { BR_ROOT, brFullGrid, MX_ROOT, mxIssuerGrid } from "./fixtures.js";
import { selectCausal } from "./parsimony.js";

function candidate(cell: Candidate["cell"], explainedDeficit: number, attempts: number): Candidate {
  return {
    cell,
    depth: Object.keys(cell).length - 2,
    attempts,
    approved: 0,
    observedRate: 0,
    expectedRate: 0.95,
    ci: { low: 0, high: 0.1 },
    explainedDeficit,
    concentration: explainedDeficit / attempts,
  };
}

describe("selectCausal", () => {
  test("prefers the concentrated cell over a diluted parent explaining the same deficit", () => {
    const chosen = selectCausal(beamSearch(brFullGrid(), BR_ROOT, 0.9, 3, fullCoverage()));

    expect(cellKey(chosen!.cell)).toBe(
      "country=BR|issuerId=itau|merchantId=BR_STORE_01|paymentMethod=CARD|providerId=adyen",
    );
  });

  test("falls back to fewer fixed dimensions when two cells cover the same rows", () => {
    // PIX implies BR, so a single-provider PIX slice and the whole PIX slice can
    // carry identical traffic. Parsimony is what breaks that structural tie.
    const wide = candidate({ merchantId: "BR_STORE_01", country: "BR", paymentMethod: "PIX" }, 60, 100);
    const narrow = candidate(
      { merchantId: "BR_STORE_01", country: "BR", paymentMethod: "PIX", providerId: "mercado_pago" },
      60,
      100,
    );

    expect(selectCausal([narrow, wide])!.cell.providerId).toBeUndefined();
  });

  test("returns null when no candidate survived the search", () => {
    expect(selectCausal([])).toBeNull();
  });
});

describe("selectCausal across providers", () => {
  test("blames the issuer, not one provider slice of it, when every provider is hit", () => {
    const chosen = selectCausal(beamSearch(mxIssuerGrid(), MX_ROOT, 0.91, 3, fullCoverage()));

    expect(cellKey(chosen!.cell)).toBe("country=MX|issuerId=bbva_mx|merchantId=MX_STORE_01");
  });
});
