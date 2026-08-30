import { describe, expect, it } from "vitest";

import { buildTransactionCells, defaultGeneratorCatalog } from "./catalog.ts";

const testTrafficWeights = {
  AR_STORE_01: 1,
  AR_STORE_02: 1,
  AR_STORE_03: 1,
  BR_STORE_01: 3,
  BR_STORE_02: 1,
  BR_STORE_03: 1,
  MX_STORE_01: 1,
  MX_STORE_02: 1,
  MX_STORE_03: 1,
};

describe("buildTransactionCells", () => {
  it("default catalog produces the 90 valid DD13 cells", () => {
    const cells = buildTransactionCells(defaultGeneratorCatalog, testTrafficWeights);

    expect(cells).toHaveLength(90);
    expect(cells.filter((cell) => cell.paymentMethod === "CARD")).toHaveLength(81);
    expect(cells.filter((cell) => cell.paymentMethod === "PIX")).toHaveLength(9);
    // AR/MX merchants: 3 routes (CARD only) x 3 issuers = 9 cells each.
    expect(cells.filter((cell) => cell.merchantId === "AR_STORE_01")).toHaveLength(9);
    expect(cells.filter((cell) => cell.merchantId === "MX_STORE_01")).toHaveLength(9);
    // BR merchants: (3 CARD routes x 3 issuers) + (3 PIX routes x 1 "NA") = 12 cells each.
    expect(cells.filter((cell) => cell.merchantId === "BR_STORE_01")).toHaveLength(12);
    expect(
      cells.every((cell) => cell.paymentMethod !== "PIX" || (cell.country === "BR" && cell.issuerId === "NA")),
    ).toBe(true);
    // A merchant never trades outside its own country.
    expect(cells.every((cell) => cell.merchantId.startsWith(cell.country))).toBe(true);
    expect(
      cells.some((cell) => cell.country === "MX" && cell.paymentMethod === "CARD" && cell.baselineConversion < 0.92),
    ).toBe(true);

    // baselineConversionFor per-route offsets, applied on top of the
    // merchant's own expectedConversion (0.92 for BR_STORE_01).
    const brCells = cells.filter((cell) => cell.merchantId === "BR_STORE_01");
    for (const cell of brCells.filter((cell) => cell.paymentMethod === "CARD")) {
      expect(cell.baselineConversion).toBeCloseTo(0.92, 12);
    }
    for (const cell of brCells.filter((cell) => cell.paymentMethod === "PIX")) {
      expect(cell.baselineConversion).toBeCloseTo(0.97, 12);
    }
    // Traffic weight within one merchant sums to that merchant's configured weight.
    const merchantTrafficWeight = brCells.reduce((total, cell) => total + cell.trafficWeight, 0);
    expect(merchantTrafficWeight).toBeCloseTo(testTrafficWeights.BR_STORE_01, 12);
  });

  it("rejects a catalog with the wrong number of merchants", () => {
    const brokenCatalog = {
      ...defaultGeneratorCatalog,
      merchants: defaultGeneratorCatalog.merchants.slice(0, 8),
    };

    expect(() => buildTransactionCells(brokenCatalog, testTrafficWeights)).toThrow(/9 merchants/);
  });
});
