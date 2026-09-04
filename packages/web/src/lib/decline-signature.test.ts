import { expect, test } from "vitest";

import { DECLINE_CODE_LABELS } from "./labels.ts";
import { DOMINANT_DECLINE_WEIGHT, declineSignatureFor } from "./decline-signature.ts";

function soleCode(signature: Record<string, number>): string {
  const codes = Object.keys(signature);
  expect(codes, "a signature must name exactly one dominant code").toHaveLength(1);
  return codes[0]!;
}

test("a PIX drop fails on the rail, which has no issuer to blame", () => {
  expect(soleCode(declineSignatureFor({ paymentMethod: "PIX" }))).toBe("AB03");
});

test("fixing an issuer concentrates the declines the issuer itself returns", () => {
  expect(soleCode(declineSignatureFor({ paymentMethod: "CARD", issuerId: "itau" }))).toBe("05");
  // The issuer is the more specific cause when both are fixed.
  expect(soleCode(declineSignatureFor({ paymentMethod: "CARD", providerId: "stripe", issuerId: "itau" }))).toBe("05");
});

test("fixing only a provider reads as the provider failing to reach the issuer", () => {
  expect(soleCode(declineSignatureFor({ paymentMethod: "CARD", providerId: "stripe" }))).toBe("91");
});

test("a drop with no provider or issuer still gets one coherent code", () => {
  // Without a signature the dominant code is whatever noise wins the window,
  // and the fingerprint carries it — so one injected fault opens a new
  // incident every time the winner changes.
  expect(soleCode(declineSignatureFor({ paymentMethod: "CARD" }))).toBe("05");
  expect(soleCode(declineSignatureFor({}))).toBe("05");
});

test("the dominant weight actually dominates the baseline mix", () => {
  // Baseline shares sum to 1.0 across the catalog, so a weight above 1 puts the
  // chosen code over every other code combined.
  expect(DOMINANT_DECLINE_WEIGHT > 1).toBeTruthy();
  expect(declineSignatureFor({ paymentMethod: "CARD", issuerId: "itau" })["05"]).toBe(DOMINANT_DECLINE_WEIGHT);
});

test("every code the console can emit is a real catalog code", () => {
  // declineCodeFor overrides weights by code and silently ignores one that is
  // not in the generator's mix, so a typo here would do nothing at all.
  const emitted = [
    declineSignatureFor({ paymentMethod: "PIX" }),
    declineSignatureFor({ paymentMethod: "CARD", issuerId: "itau" }),
    declineSignatureFor({ paymentMethod: "CARD", providerId: "stripe" }),
    declineSignatureFor({}),
  ];
  for (const signature of emitted) {
    expect(DECLINE_CODE_LABELS[soleCode(signature)]).toBeTruthy();
  }
});
