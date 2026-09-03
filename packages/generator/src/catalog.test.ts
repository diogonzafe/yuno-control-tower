import { describe, expect, it } from "vitest";

import { buildGeneratorCatalog, buildTransactionCells } from "./catalog.ts";

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

describe("buildGeneratorCatalog", () => {
  it("applies the given default conversion to every merchant", () => {
    const catalog = buildGeneratorCatalog({ defaultConversion: 0.8 });

    expect(catalog.merchants.every((merchant) => merchant.expectedConversion === 0.8)).toBe(true);
  });

  it("falls back to 0.90 when no default conversion is given", () => {
    const catalog = buildGeneratorCatalog();

    expect(catalog.merchants.every((merchant) => merchant.expectedConversion === 0.9)).toBe(true);
  });

  it("randomizes each merchant's conversion within +/-0.05 of the default when asked to", () => {
    const catalog = buildGeneratorCatalog({ defaultConversion: 0.9, randomizeConversion: true });
    const values = catalog.merchants.map((merchant) => merchant.expectedConversion);

    expect(new Set(values).size).toBeGreaterThan(1);
    expect(values.every((value) => value >= 0.85 && value <= 0.95)).toBe(true);
  });

  it("rejects a default conversion outside (0, 1)", () => {
    expect(() => buildGeneratorCatalog({ defaultConversion: 1 })).toThrow(/probability strictly between 0 and 1/);
  });
});

describe("buildTransactionCells", () => {
  it("default catalog produces the 90 valid DD13 cells", () => {
    const catalog = buildGeneratorCatalog({ defaultConversion: 0.9 });
    const cells = buildTransactionCells(catalog, testTrafficWeights);

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
    // Every route generates at the merchant's own expectedConversion, with no
    // per-country or per-method offset. The detector compares observed rates
    // against merchants.expected_conversion; any offset here that the catalog
    // does not carry reads as a permanent, un-injected material drop for that
    // route (MX sat 4pp under its expected rate and alerted forever).
    for (const cell of cells) {
      expect(cell.baselineConversion).toBeCloseTo(0.9, 12);
    }

    const brCells = cells.filter((cell) => cell.merchantId === "BR_STORE_01");
    // Traffic weight within one merchant sums to that merchant's configured weight.
    const merchantTrafficWeight = brCells.reduce((total, cell) => total + cell.trafficWeight, 0);
    expect(merchantTrafficWeight).toBeCloseTo(testTrafficWeights.BR_STORE_01, 12);
  });

  it("rejects a catalog with the wrong number of merchants", () => {
    const catalog = buildGeneratorCatalog();
    const brokenCatalog = { ...catalog, merchants: catalog.merchants.slice(0, 8) };

    expect(() => buildTransactionCells(brokenCatalog, testTrafficWeights)).toThrow(/9 merchants/);
  });
});
