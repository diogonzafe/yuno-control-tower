import { describe, expect, test } from "vitest";
import { fullCoverage } from "../detect/fixtures.js";
import { beamSearch } from "./beam-search.js";
import { BR_ROOT, brFullGrid } from "./fixtures.js";

const key = (cell: Record<string, string | undefined>) =>
  Object.entries(cell)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dimension, value]) => `${dimension}=${value}`)
    .join("|");

describe("beamSearch", () => {
  test("reaches the causal cell three dimensions below the root", () => {
    const candidates = beamSearch(brFullGrid(), BR_ROOT, 0.9, 3, fullCoverage());

    const causal = candidates.find(
      (c) => key(c.cell) === "country=BR|issuerId=itau|merchantId=BR_STORE_01|paymentMethod=CARD|providerId=adyen",
    );

    expect(causal).toBeDefined();
    expect(causal!.depth).toBe(3);
    expect(causal!.attempts).toBe(300);
    expect(causal!.approved).toBe(30);
    expect(causal!.expectedRate).toBeCloseTo(0.95, 6);
    expect(causal!.explainedDeficit).toBeCloseTo(182, 6);
  });

  test("never splits by issuer while the slice still carries PIX traffic", () => {
    const candidates = beamSearch(brFullGrid(), BR_ROOT, 0.9, 3, fullCoverage());

    const issuerWithoutCard = candidates.filter(
      (c) => c.cell.issuerId !== undefined && c.cell.paymentMethod !== "CARD",
    );

    expect(issuerWithoutCard).toEqual([]);
  });

  test("returns nothing when the root shows no material drop", () => {
    const healthy = brFullGrid().map((row) =>
      row.providerId === "adyen" && row.issuerId === "itau"
        ? { ...row, attempts: 300, approved: 285 }
        : row,
    );

    expect(beamSearch(healthy, BR_ROOT, 0.9, 3, fullCoverage())).toEqual([]);
  });
});
