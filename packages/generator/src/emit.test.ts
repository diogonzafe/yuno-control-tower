import { describe, expect, it } from "vitest";

import { emitTransaction } from "./emit.ts";

describe("emitTransaction", () => {
  it("writes a transaction as one Redis Stream event field", async () => {
    const calls: unknown[][] = [];
    const event = {
      transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      merchantOrderId: "order-1",
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "PIX",
      currency: "BRL",
      amountMinor: 1_000,
      fxRate: 0.18,
      fxRateDate: "2026-08-30",
      fxSource: "MOCK",
      amountUsdMinor: 180,
      status: "SUCCESS",
      issuerId: "NA",
      createdAt: "2026-08-30T12:00:00.000Z",
    } as const;

    await emitTransaction(
      {
        xadd: async (...arguments_) => {
          calls.push(arguments_);
        },
      },
      event,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual(["stream:transactions", "*", "payload"]);
    expect(JSON.parse(calls[0]![3] as string)).toEqual(event);
  });
});
