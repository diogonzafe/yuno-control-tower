import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { transactions } from "../db/schema";
import { insertTransactions } from "./insert-transactions";

function testEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    transactionId: randomUUID(),
    merchantOrderId: "order-test",
    merchantId: "BR_STORE_01",
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
    // The epoch, not today: this test writes to the shared production-shape
    // database, so it must never land in a minute real data could occupy.
    createdAt: "1970-01-01T14:03:10.000Z",
    ...overrides,
  };
}

const insertedIds: string[] = [];

afterEach(async () => {
  if (insertedIds.length > 0) {
    await db.delete(transactions).where(inArray(transactions.transactionId, insertedIds));
    insertedIds.length = 0;
  }
});

describe("insertTransactions", () => {
  it("inserts new transactions and returns their ids", async () => {
    const event = testEvent();
    insertedIds.push(event.transactionId);

    const result = await insertTransactions(db, [event]);

    expect(result).toEqual(new Set([event.transactionId]));

    const [row] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.transactionId, event.transactionId));
    expect(row?.merchantId).toBe("BR_STORE_01");
    expect(row?.amountMinor).toBe(1000);
  });

  it("does not insert the same transaction twice and excludes it from the returned set", async () => {
    const event = testEvent();
    insertedIds.push(event.transactionId);

    await insertTransactions(db, [event]);
    const secondResult = await insertTransactions(db, [event]);

    expect(secondResult.size).toBe(0);
  });

  it("returns an empty set for an empty batch without querying", async () => {
    const result = await insertTransactions(db, []);
    expect(result).toEqual(new Set());
  });
});
