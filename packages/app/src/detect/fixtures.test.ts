import { describe, expect, it } from "vitest";
import { countryOf, fullCoverage, merchant, rollupRow } from "./fixtures.js";

describe("detector fixtures", () => {
  it("provides the real seed identifiers and DD13 coverage mesh", () => {
    expect(rollupRow({ approved: 40, providerId: "stripe" })).toMatchObject({ merchantId: "BR_STORE_01", providerId: "stripe", approved: 40, attempts: 100 });
    expect(merchant({ expectedConversion: .65 }).expectedConversion).toBe(.65);
    expect(countryOf("MX_STORE_02")).toBe("MX");
    expect(() => countryOf("ZZ_STORE_01")).toThrow();
    const coverage = fullCoverage();
    expect(coverage).toHaveLength(12);
    expect(coverage.filter((entry) => entry.paymentMethod === "PIX").every((entry) => entry.country === "BR")).toBe(true);
  });
});
