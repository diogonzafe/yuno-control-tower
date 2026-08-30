import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { transactions, rollupMinute } from "../db/schema";
import { processBatch } from "./rollup";

const BUCKET = new Date("2026-08-30T14:07:00.000Z");
// `processBatch` inserts into `transactions`, which has a NOT NULL FK to
// `merchants` — use a real seeded merchant id (BR_STORE_01), never a
// fabricated one, so this test never has to touch the shared catalog table.
const MERCHANT_ID = "BR_STORE_01";

function testEvent(id: string, overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    transactionId: id,
    merchantOrderId: `order-${id}`,
    merchantId: MERCHANT_ID,
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 1000,
    fxRate: 5,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 200,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: null,
    latencyMs: null,
    createdAt: "2026-08-30T14:07:10.000Z",
    ...overrides,
  };
}

const usedIds: string[] = [];

afterEach(async () => {
  if (usedIds.length > 0) {
    await db.delete(transactions).where(inArray(transactions.transactionId, usedIds));
  }
  await db
    .delete(rollupMinute)
    .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
  usedIds.length = 0;
});

describe("processBatch", () => {
  it("inserts transactions and updates rollups together", async () => {
    const id = randomUUID();
    usedIds.push(id);

    const result = await processBatch([testEvent(id)]);

    expect(result.insertedCount).toBe(1);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
    expect(row).toMatchObject({ attempts: 1, approved: 1 });
  });

  it("is idempotent under exact redelivery: processing the same batch twice leaves rollups unchanged", async () => {
    const id = randomUUID();
    usedIds.push(id);
    const event = testEvent(id);

    const first = await processBatch([event]);
    const second = await processBatch([event]);

    expect(first.insertedCount).toBe(1);
    expect(second.insertedCount).toBe(0);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
    expect(row).toMatchObject({ attempts: 1, approved: 1 });
  });

  it("is idempotent for a mixed batch: only the genuinely new events affect the rollup", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    usedIds.push(idA, idB);

    await processBatch([testEvent(idA)]);
    const result = await processBatch([testEvent(idA), testEvent(idB)]);

    expect(result.insertedCount).toBe(1);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
    expect(row).toMatchObject({ attempts: 2, approved: 2 });
  });
});
