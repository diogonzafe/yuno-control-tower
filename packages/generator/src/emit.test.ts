import assert from "node:assert/strict";
import test from "node:test";

import { emitTransaction } from "./emit.ts";

test("emitter writes a transaction as one Redis Stream event field", async () => {
  const calls: unknown[][] = [];
  const event = {
    transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    merchantOrderId: "order-1",
    merchantId: "merchant-a",
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
  await emitTransaction({
    xadd: async (...arguments_) => { calls.push(arguments_); },
  }, event);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 3), ["stream:transactions", "*", "payload"]);
  assert.deepEqual(JSON.parse(calls[0]![3] as string), event);
});
