import { describe, expect, it } from "vitest";
import { crossSectionalSweep } from "./trigger.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "./types.js";

const bucket = "2026-09-04T19:20:00.000Z";
const merchant: MerchantConfig = { merchantId: "BR_STORE_01", expectedConversion: .9, minMaterialDropPp: 3 };
const coverage: RoutingCoverage = ["adyen", "stripe"].map((providerId) => ({ providerId, country: "BR", paymentMethod: "CARD" }));

// Equal volume in all four cells, so every aggregate below is a plain average
// and the masking is arithmetic rather than a weighting artefact.
function cell(providerId: string, issuerId: string, approved: number): RollupRow {
  return { bucket, merchantId: "BR_STORE_01", providerId, country: "BR", paymentMethod: "CARD", issuerId, attempts: 100, approved, amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950 };
}

/**
 * A known, measured limitation — not a passing feature.
 *
 * Two causes under one merchant, one of them living in a provider x issuer cell.
 *
 * Measured in production on 2026-09-04: `adyen x nubank` was injected at ~0.32
 * against a 0.90 baseline with ~36 attempts a minute, alongside a severe
 * `stripe x itau`. It opened an incident once and then went invisible for the
 * rest of the outage.
 *
 * `splitsOf` only ever descends one dimension below the merchant x country
 * root, so that cell is never tested on its own — it can only be seen diluted,
 * either as adyen across all its issuers or as nubank across all its providers.
 * In both of those slices the healthy half of the traffic lifts the average
 * back above the sibling reference, which the other cause has meanwhile pulled
 * down. The fault is arithmetically invisible at every slice the sweep looks at.
 *
 * Adding that split (`c1ffd0d`) did catch it, and was reverted: the cells carry
 * ~40 attempts a minute against a MIN_VOLUME of 30, and testing four times as
 * many hypotheses per window at a fixed 95% level took the incident rate from
 * 5.4 to 21.2 an hour. This file keeps the arithmetic on record so the next
 * attempt starts from it rather than rediscovering it — the way through is
 * `spec.md` §8 question 3, controlling multiple comparisons, still open.
 */
describe("a fault in a provider x issuer cell", () => {
  const rows = [
    cell("stripe", "itau", 9),    // the severe cause
    cell("adyen", "nubank", 32),  // the moderate one, masked at both slices
    cell("stripe", "nubank", 92),
    cell("adyen", "itau", 92),
  ];

  const dropping = crossSectionalSweep(rows, coverage, [merchant])
    .filter((candidate) => candidate.state === "MATERIAL_DROP")
    .map((candidate) => candidate.dimensions);

  it("is invisible in the provider slice, which its own healthy issuer lifts", () => {
    // adyen = (92 + 32) / 200 = 0.62, against stripe = (9 + 92) / 200 = 0.505.
    // Against that reference adyen reads better than expected, not worse.
    expect(dropping).not.toContainEqual({ merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" });
  });

  it("is invisible in the issuer slice, for the mirror-image reason", () => {
    // nubank = (92 + 32) / 200 = 0.62, against itau = (9 + 92) / 200 = 0.505.
    expect(dropping).not.toContainEqual({ merchantId: "BR_STORE_01", country: "BR", paymentMethod: "CARD", issuerId: "nubank" });
  });

  // The sweep does not descend to `provider x issuer`, so the cell where this
  // fault lives undiluted is never tested. Asserting the gap keeps the cost of
  // the limitation visible: 0.32 against a 0.92 sibling is a 60pp difference
  // nobody is looking at.
  it("is never tested at the depth where it would be a 60pp gap", () => {
    expect(dropping).not.toContainEqual({
      merchantId: "BR_STORE_01",
      country: "BR",
      paymentMethod: "CARD",
      providerId: "adyen",
      issuerId: "nubank",
    });
  });

  // The severe cause is caught, and that is why the pair reads as one incident
  // rather than none: stripe separates from adyen at the provider slice.
  it("still catches the severe cause at the depth the sweep does reach", () => {
    expect(dropping).toContainEqual({ merchantId: "BR_STORE_01", country: "BR", providerId: "stripe" });
  });
});
