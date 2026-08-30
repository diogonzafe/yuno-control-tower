import assert from "node:assert/strict";
import test from "node:test";

import { declineCodeFor, declineMixFor } from "./mix.ts";

test("card decline mix totals one", () => {
  const total = declineMixFor("CARD").reduce((sum, entry) => sum + entry.weight, 0);

  assert.ok(Math.abs(total - 1) < 1e-12);
});

test("PIX only emits PIX decline codes", () => {
  const code = declineCodeFor("PIX", () => 0.99);

  assert.equal(code.code, "PIX_RECEIVER_REJECTED");
  assert.equal(code.rawCode, "BE17");
});

test("Visa and Mastercard normalize raw code 65 differently", () => {
  const visa = declineCodeFor("CARD", () => 0.999, "Visa");
  const mastercard = declineCodeFor("CARD", () => 0.999, "Mastercard");

  assert.equal(visa.code, "LIMIT_EXCEEDED");
  assert.equal(mastercard.code, "AUTH_REQUIRED");
});

test("catalog exposes all 18 codes with diagnostic metadata", () => {
  const cardCodes = declineMixFor("CARD");
  const pixCodes = declineMixFor("PIX");

  assert.equal(cardCodes.length + pixCodes.length, 18);
  assert.equal(cardCodes.find((code) => code.code === "INSUFFICIENT_FUNDS")!.diagnostic, false);
  assert.equal(pixCodes.find((code) => code.code === "PIX_SPI_TIMEOUT")!.family, "network");
});

test("baseline decline mix varies slightly by country and issuer", () => {
  const brItau = declineMixFor("CARD", { country: "BR", issuerId: "itau" });
  const mxBbva = declineMixFor("CARD", { country: "MX", issuerId: "bbva-mexico" });

  assert.notDeepEqual(brItau, mxBbva);
  assert.ok(Math.abs(brItau.reduce((sum, code) => sum + code.weight, 0) - 1) < 1e-12);
  assert.ok(Math.abs(mxBbva.reduce((sum, code) => sum + code.weight, 0) - 1) < 1e-12);
});
