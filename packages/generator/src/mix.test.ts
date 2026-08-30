import { describe, expect, it } from "vitest";

import { declineCodeFor, declineMixFor } from "./mix.ts";

describe("declineMixFor / declineCodeFor", () => {
  it("card decline mix totals one", () => {
    const total = declineMixFor("CARD").reduce((sum, entry) => sum + entry.weight, 0);

    expect(Math.abs(total - 1)).toBeLessThan(1e-12);
  });

  it("PIX only emits PIX decline codes", () => {
    const code = declineCodeFor("PIX", () => 0.99);

    expect(code.code).toBe("BE17");
  });

  it("exposes every real seeded decline code with its catalog family and diagnostic metadata", () => {
    const cardCodes = declineMixFor("CARD");
    const pixCodes = declineMixFor("PIX");

    // 17 real CARD codes + 6 real PIX codes in the seeded decline_codes table.
    expect(cardCodes.length + pixCodes.length).toBe(23);
    expect(cardCodes.find((code) => code.code === "51")?.diagnostic).toBe(false);
    expect(cardCodes.find((code) => code.code === "51")?.family).toBe("funds");
    expect(pixCodes.find((code) => code.code === "AB03")?.family).toBe("network");
  });

  it("baseline decline mix varies slightly by country and issuer", () => {
    const brItau = declineMixFor("CARD", { country: "BR", issuerId: "itau" });
    const mxBbva = declineMixFor("CARD", { country: "MX", issuerId: "bbva_mx" });

    expect(brItau).not.toEqual(mxBbva);
    expect(Math.abs(brItau.reduce((sum, code) => sum + code.weight, 0) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(mxBbva.reduce((sum, code) => sum + code.weight, 0) - 1)).toBeLessThan(1e-12);
  });

  it("respects an override weight, forcing a specific code", () => {
    const code = declineCodeFor("CARD", () => 0.5, { "91": 1000 });

    expect(code.code).toBe("91");
  });
});
