import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { transactions, rollupMinute, rollupDeclinesMinute } from "../db/schema";
import { processBatch } from "./process-batch";

// The epoch, deliberately: this test writes to and deletes from the shared
// production-shape database, so the bucket must be a minute no real (or
// demo-generated) transaction can ever fall into.
const BUCKET = new Date("1970-01-01T00:00:00.000Z");
const CREATED_AT = "1970-01-01T00:00:10.000Z";
// `processBatch` inserts into `transactions`, which has a NOT NULL FK to
// `merchants` — use a real seeded merchant id (BR_STORE_01), never a
// fabricated one, so this test never has to touch the shared catalog table.
const MERCHANT_ID = "BR_STORE_01";
const PROVIDER_ID = "adyen";
const COUNTRY = "BR";
const PAYMENT_METHOD = "CARD";
const ISSUER_ID = "itau";
const DECLINE_CODE = "05";

function testEvent(id: string, overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    transactionId: id,
    merchantOrderId: `order-${id}`,
    merchantId: MERCHANT_ID,
    providerId: PROVIDER_ID,
    country: COUNTRY,
    paymentMethod: PAYMENT_METHOD,
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
    issuerId: ISSUER_ID,
    token: null,
    latencyMs: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

// Scoped by the tables' FULL primary keys: the delete can only ever remove the
// exact cell this file produces, never a sibling cell of the same merchant.
const rollupMinuteCell = and(
  eq(rollupMinute.bucket, BUCKET),
  eq(rollupMinute.merchantId, MERCHANT_ID),
  eq(rollupMinute.providerId, PROVIDER_ID),
  eq(rollupMinute.country, COUNTRY),
  eq(rollupMinute.paymentMethod, PAYMENT_METHOD),
  eq(rollupMinute.issuerId, ISSUER_ID),
);

const rollupDeclinesCell = and(
  eq(rollupDeclinesMinute.bucket, BUCKET),
  eq(rollupDeclinesMinute.merchantId, MERCHANT_ID),
  eq(rollupDeclinesMinute.providerId, PROVIDER_ID),
  eq(rollupDeclinesMinute.country, COUNTRY),
  eq(rollupDeclinesMinute.paymentMethod, PAYMENT_METHOD),
  eq(rollupDeclinesMinute.issuerId, ISSUER_ID),
  eq(rollupDeclinesMinute.declineCode, DECLINE_CODE),
);

const usedIds: string[] = [];

afterEach(async () => {
  if (usedIds.length > 0) {
    await db.delete(transactions).where(inArray(transactions.transactionId, usedIds));
  }
  await db.delete(rollupMinute).where(rollupMinuteCell);
  await db.delete(rollupDeclinesMinute).where(rollupDeclinesCell);
  usedIds.length = 0;
});

describe("processBatch", () => {
  it("inserts transactions and updates rollups together", async () => {
    const id = randomUUID();
    usedIds.push(id);

    const result = await processBatch([testEvent(id)]);

    expect(result.insertedCount).toBe(1);

    const [row] = await db.select().from(rollupMinute).where(rollupMinuteCell);
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

    const [row] = await db.select().from(rollupMinute).where(rollupMinuteCell);
    expect(row).toMatchObject({ attempts: 1, approved: 1 });
  });

  it("is idempotent for a mixed batch: only the genuinely new events affect the rollup", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    usedIds.push(idA, idB);

    await processBatch([testEvent(idA)]);
    const result = await processBatch([testEvent(idA), testEvent(idB)]);

    expect(result.insertedCount).toBe(1);

    const [row] = await db.select().from(rollupMinute).where(rollupMinuteCell);
    expect(row).toMatchObject({ attempts: 2, approved: 2 });
  });

  it("records a DECLINED event in both rollup tables alongside a SUCCESS in the same cell", async () => {
    const successId = randomUUID();
    const declinedId = randomUUID();
    usedIds.push(successId, declinedId);

    const result = await processBatch([
      testEvent(successId),
      testEvent(declinedId, {
        status: "DECLINED",
        declineCode: DECLINE_CODE,
        rawDeclineCode: "51",
      }),
    ]);

    expect(result.insertedCount).toBe(2);

    const [minuteRow] = await db.select().from(rollupMinute).where(rollupMinuteCell);
    expect(minuteRow).toMatchObject({ attempts: 2, approved: 1 });

    const [declineRow] = await db
      .select()
      .from(rollupDeclinesMinute)
      .where(rollupDeclinesCell);
    expect(declineRow).toMatchObject({ declineCode: DECLINE_CODE, count: 1 });
  });
});
