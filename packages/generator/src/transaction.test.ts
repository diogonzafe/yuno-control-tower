import { describe, expect, it } from "vitest";
import { transactionEventSchema } from "@control-tower/contracts";

import { createSeededRandom } from "./random.ts";
import { generateTransaction } from "./transaction.ts";

describe("generateTransaction", () => {
  it("emits a contract-shaped successful PIX transaction", () => {
    const event = generateTransaction({
      random: createSeededRandom(17),
      transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      merchantOrderId: "order-1",
      createdAt: "2026-08-30T12:00:00.000Z",
      cell: {
        merchantId: "BR_STORE_01",
        providerId: "adyen",
        country: "BR",
        paymentMethod: "PIX",
        issuerId: "NA",
        baselineConversion: 1,
      },
      amountMinor: 10_000,
    });

    expect(event.status).toBe("SUCCESS");
    expect(event.currency).toBe("BRL");
    expect(event.amountUsdMinor).toBe(1_800);
    expect(event.declineCode).toBeNull();
    expect(event.rawDeclineCode).toBeNull();
    expect(event.issuerId).toBe("NA");
    expect(event.cardBrand).toBeNull();
    expect(transactionEventSchema.parse(event)).toEqual(event);
  });

  it("an active incident lowers approval probability and adds its decline signature", () => {
    const event = generateTransaction({
      random: { next: () => 0.9 },
      transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
      merchantOrderId: "order-2",
      createdAt: "2026-08-30T12:01:00.000Z",
      cell: {
        merchantId: "BR_STORE_01",
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
        declineWeights: { "91": 1000 },
      }],
    });

    expect(event.status).toBe("DECLINED");
    // "91" (issuer unavailable) is the real seeded code driven to near-certainty
    // by the incident's declineWeights override.
    expect(event.declineCode).toBe("91");
    expect(event.rawDeclineCode).toBe("91");
    expect(event.latencyMs).toBe(320);
  });
});
