import assert from "node:assert/strict";
import test from "node:test";
import { transactionEventSchema } from "@control-tower/contracts";

import { createSeededRandom } from "./random.ts";
import { generateTransaction } from "./transaction.ts";

test("generator emits a contract-shaped successful PIX transaction", () => {
  const event = generateTransaction({
    random: createSeededRandom(17),
    transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    merchantOrderId: "order-1",
    createdAt: "2026-08-30T12:00:00.000Z",
    cell: {
      merchantId: "merchant-a",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "PIX",
      issuerId: "NA",
      baselineConversion: 1,
    },
    amountMinor: 10_000,
  });

  assert.equal(event.status, "SUCCESS");
  assert.equal(event.currency, "BRL");
  assert.equal(event.amountUsdMinor, 1_800);
  assert.equal(event.declineCode, null);
  assert.equal(event.rawDeclineCode, null);
  assert.equal(event.issuerId, "NA");
  assert.equal(event.cardBrand, null);
  assert.deepEqual(transactionEventSchema.parse(event), event);
});

test("an active incident lowers approval probability and adds its decline signature", () => {
  const event = generateTransaction({
    random: { next: () => 0.9 },
    transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
    merchantOrderId: "order-2",
    createdAt: "2026-08-30T12:01:00.000Z",
    cell: {
      merchantId: "merchant-a",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
      baselineConversion: 0.95,
    },
    amountMinor: 10_000,
    incidents: [{
      id: "provider-br",
      startsAt: "2026-08-30T12:00:00.000Z",
      dimensions: { providerId: "adyen", country: "BR" },
      conversionMultiplier: 0.5,
      latencyMsIncrease: 200,
      declineWeights: { ISSUER_UNAVAILABLE: 1 },
    }],
  });

  assert.equal(event.status, "DECLINED");
  assert.equal(event.declineCode, "ISSUER_UNAVAILABLE");
  assert.equal(event.rawDeclineCode, "91");
  assert.equal(event.latencyMs, 320);
});
