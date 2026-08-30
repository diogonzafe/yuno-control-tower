import { describe, expect, it } from "vitest";

import { generateTransaction } from "./transaction.ts";

describe("generateTransaction routes", () => {
  it("covers every valid country and payment-method route with real seeded ids", () => {
    const routes = [
      { merchantId: "AR_STORE_01", country: "AR", paymentMethod: "CARD", issuerId: "galicia", currency: "ARS" },
      { merchantId: "MX_STORE_01", country: "MX", paymentMethod: "CARD", issuerId: "bbva_mx", currency: "MXN" },
      { merchantId: "BR_STORE_01", country: "BR", paymentMethod: "CARD", issuerId: "itau", currency: "BRL" },
      { merchantId: "BR_STORE_01", country: "BR", paymentMethod: "PIX", issuerId: "NA", currency: "BRL" },
    ] as const;

    for (const [index, route] of routes.entries()) {
      const event = generateTransaction({
        random: { next: () => 0 },
        transactionId: `f47ac10b-58cc-4372-a567-0e02b2c3d48${index}`,
        merchantOrderId: `order-${index}`,
        createdAt: "2026-08-30T12:00:00.000Z",
        amountMinor: 10_000,
        cell: {
          providerId: "adyen",
          baselineConversion: 1,
          ...route,
        },
      });

      expect(event.status).toBe("SUCCESS");
      expect(event.currency).toBe(route.currency);
      expect(event.declineCode).toBeNull();
      expect(event.rawDeclineCode).toBeNull();
      expect(event.amountUsdMinor).toBeGreaterThanOrEqual(0);

      if (route.paymentMethod === "PIX") {
        expect(event.issuerId).toBe("NA");
        expect(event.cardBrand).toBeNull();
        expect(event.cardType).toBeNull();
        expect(event.cardBin).toBeNull();
      } else {
        expect(event.cardBrand).toBeTruthy();
        expect(event.cardType).toBeTruthy();
        expect(event.cardBin).toMatch(/^\d{6}$/);
      }
    }
  });

  it("a decline always contains a real seeded decline code, duplicated as declineCode and rawDeclineCode", () => {
    const event = generateTransaction({
      random: { next: () => 0.25 },
      transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d490",
      merchantOrderId: "declined-order",
      createdAt: "2026-08-30T12:00:00.000Z",
      amountMinor: 10_000,
      cell: {
        merchantId: "BR_STORE_01",
        providerId: "adyen",
        country: "BR",
        paymentMethod: "CARD",
        issuerId: "itau",
        baselineConversion: 0,
      },
    });

    expect(event.status).toBe("DECLINED");
    expect(event.declineCode).toBeTruthy();
    expect(event.rawDeclineCode).toBe(event.declineCode);
  });

  it("Elo is only emitted for Brazilian cards", () => {
    const event = generateTransaction({
      random: { next: () => 0.99 },
      transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d493",
      merchantOrderId: "ar-card",
      createdAt: "2026-08-30T12:00:00.000Z",
      amountMinor: 10_000,
      cell: {
        merchantId: "AR_STORE_01",
        providerId: "adyen",
        country: "AR",
        paymentMethod: "CARD",
        issuerId: "galicia",
        baselineConversion: 1,
      },
    });

    expect(event.cardBrand).not.toBe("Elo");
  });

  it("rejects the invalid PIX country-method combination", () => {
    expect(() =>
      generateTransaction({
        random: { next: () => 0 },
        transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d491",
        merchantOrderId: "invalid-pix",
        createdAt: "2026-08-30T12:00:00.000Z",
        amountMinor: 10_000,
        cell: {
          merchantId: "MX_STORE_01",
          providerId: "adyen",
          country: "MX",
          paymentMethod: "PIX",
          issuerId: "NA",
          baselineConversion: 1,
        },
      }),
    ).toThrow(/PIX requires country BR/);
  });

  it("rejects a timestamp that would fail the shared contract", () => {
    expect(() =>
      generateTransaction({
        random: { next: () => 0 },
        transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d492",
        merchantOrderId: "invalid-time",
        createdAt: "2026-08-30 12:00:00",
        amountMinor: 10_000,
        cell: {
          merchantId: "BR_STORE_01",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "PIX",
          issuerId: "NA",
          baselineConversion: 1,
        },
      }),
    ).toThrow(/createdAt must be an ISO timestamp with an offset/);
  });
});
