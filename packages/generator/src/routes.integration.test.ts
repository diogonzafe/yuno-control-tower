import assert from "node:assert/strict";
import test from "node:test";

import { generateTransaction } from "./transaction.ts";

test("generator covers every valid country and payment-method route", () => {
  const routes = [
    { country: "AR", paymentMethod: "CARD", issuerId: "galicia", currency: "ARS" },
    { country: "MX", paymentMethod: "CARD", issuerId: "bbva-mx", currency: "MXN" },
    { country: "BR", paymentMethod: "CARD", issuerId: "itau", currency: "BRL" },
    { country: "BR", paymentMethod: "PIX", issuerId: "NA", currency: "BRL" },
  ] as const;

  for (const [index, route] of routes.entries()) {
    const event = generateTransaction({
      random: { next: () => 0 },
      transactionId: `f47ac10b-58cc-4372-a567-0e02b2c3d48${index}`,
      merchantOrderId: `order-${index}`,
      createdAt: "2026-08-30T12:00:00.000Z",
      amountMinor: 10_000,
      cell: {
        merchantId: "merchant-a",
        providerId: "adyen",
        baselineConversion: 1,
        ...route,
      },
    });

    assert.equal(event.status, "SUCCESS");
    assert.equal(event.currency, route.currency);
    assert.equal(event.declineCode, null);
    assert.equal(event.rawDeclineCode, null);
    assert.ok(event.amountUsdMinor >= 0);

    if (route.paymentMethod === "PIX") {
      assert.equal(event.issuerId, "NA");
      assert.equal(event.cardBrand, null);
      assert.equal(event.cardType, null);
      assert.equal(event.cardBin, null);
    } else {
      assert.ok(event.cardBrand);
      assert.ok(event.cardType);
      assert.match(event.cardBin!, /^\d{6}$/);
    }
  }
});

test("a decline always contains normalized and raw decline codes", () => {
  const event = generateTransaction({
    random: { next: () => 0.25 },
    transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d490",
    merchantOrderId: "declined-order",
    createdAt: "2026-08-30T12:00:00.000Z",
    amountMinor: 10_000,
    cell: {
      merchantId: "merchant-a",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
        baselineConversion: 0,
    },
  });

  assert.equal(event.status, "DECLINED");
  assert.ok(event.declineCode);
  assert.ok(event.rawDeclineCode);
});

test("Elo is only emitted for Brazilian cards", () => {
  const event = generateTransaction({
    random: { next: () => 0.99 },
    transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d493",
    merchantOrderId: "ar-card",
    createdAt: "2026-08-30T12:00:00.000Z",
    amountMinor: 10_000,
    cell: {
      merchantId: "merchant-a",
      providerId: "adyen",
      country: "AR",
      paymentMethod: "CARD",
      issuerId: "galicia",
      baselineConversion: 1,
    },
  });

  assert.notEqual(event.cardBrand, "Elo");
});

test("generator rejects the invalid PIX country-method combination", () => {
  assert.throws(
    () => generateTransaction({
      random: { next: () => 0 },
      transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d491",
      merchantOrderId: "invalid-pix",
      createdAt: "2026-08-30T12:00:00.000Z",
      amountMinor: 10_000,
      cell: {
        merchantId: "merchant-a",
        providerId: "adyen",
        country: "MX",
        paymentMethod: "PIX",
        issuerId: "NA",
        baselineConversion: 1,
      },
    }),
    /PIX requires country BR/,
  );
});

test("generator rejects a timestamp that would fail the shared contract", () => {
  assert.throws(
    () => generateTransaction({
      random: { next: () => 0 },
      transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d492",
      merchantOrderId: "invalid-time",
      createdAt: "2026-08-30 12:00:00",
      amountMinor: 10_000,
      cell: {
        merchantId: "merchant-a",
        providerId: "adyen",
        country: "BR",
        paymentMethod: "PIX",
        issuerId: "NA",
        baselineConversion: 1,
      },
    }),
    /createdAt must be an ISO timestamp with an offset/,
  );
});
