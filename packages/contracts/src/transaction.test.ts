import { describe, expect, it } from "vitest";
import { transactionEventSchema } from "./transaction";

function validCardEvent(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "9f0b8b0e-6b0a-4b8a-8b0a-6b0a4b8a8b0a",
    merchantOrderId: "order-1",
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 10000,
    fxRate: 5.2,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 1923,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: "tok_123",
    latencyMs: 120,
    createdAt: "2026-08-30T14:03:00.000Z",
    ...overrides,
  };
}

describe("transactionEventSchema", () => {
  it("accepts a valid CARD/SUCCESS event", () => {
    const result = transactionEventSchema.safeParse(validCardEvent());
    expect(result.success).toBe(true);
  });

  it("accepts a valid PIX event in BR", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({
        paymentMethod: "PIX",
        country: "BR",
        cardBrand: null,
        cardType: null,
        cardBin: null,
        issuerId: "NA",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects PIX outside BR", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ paymentMethod: "PIX", country: "MX" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects DECLINED without a declineCode", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ status: "DECLINED", declineCode: null }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects SUCCESS with a declineCode present", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ status: "SUCCESS", declineCode: "05" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts DECLINED with a declineCode", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ status: "DECLINED", declineCode: "05" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an unknown country", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ country: "US" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative amountMinor", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ amountMinor: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it("treats an omitted optional field the same as an explicit null", () => {
    const event = validCardEvent();
    delete (event as Record<string, unknown>).cardBrand;
    const result = transactionEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});
