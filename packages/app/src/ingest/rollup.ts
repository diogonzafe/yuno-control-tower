import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { insertTransactions } from "./insert-transactions";
import { upsertRollupDeclinesMinute, upsertRollupMinute } from "./upsert-rollups";

export type RollupMinuteDelta = {
  bucket: Date;
  merchantId: string;
  providerId: string;
  country: string;
  paymentMethod: string;
  issuerId: string;
  attempts: number;
  approved: number;
  amountMinorSum: number;
  amountUsdSum: number;
  approvedUsdSum: number;
};

export type RollupDeclineDelta = {
  bucket: Date;
  merchantId: string;
  providerId: string;
  country: string;
  paymentMethod: string;
  issuerId: string;
  declineCode: string;
  count: number;
};

export type AggregatedDeltas = {
  minuteDeltas: RollupMinuteDelta[];
  declineDeltas: RollupDeclineDelta[];
};

function floorToMinute(isoTimestamp: string): Date {
  const date = new Date(isoTimestamp);
  date.setUTCSeconds(0, 0);
  return date;
}

function cellKey(bucket: Date, event: TransactionEvent): string {
  return JSON.stringify([
    bucket.toISOString(),
    event.merchantId,
    event.providerId,
    event.country,
    event.paymentMethod,
    event.issuerId,
  ]);
}

function declineCellKey(bucket: Date, event: TransactionEvent, declineCode: string): string {
  return JSON.stringify([
    bucket.toISOString(),
    event.merchantId,
    event.providerId,
    event.country,
    event.paymentMethod,
    event.issuerId,
    declineCode,
  ]);
}

export function aggregateDeltas(events: TransactionEvent[]): AggregatedDeltas {
  const minuteMap = new Map<string, RollupMinuteDelta>();
  const declineMap = new Map<string, RollupDeclineDelta>();

  for (const event of events) {
    const bucket = floorToMinute(event.createdAt);
    const key = cellKey(bucket, event);
    const isApproved = event.status === "SUCCESS";
    const existing = minuteMap.get(key);

    if (existing) {
      existing.attempts += 1;
      existing.approved += isApproved ? 1 : 0;
      existing.amountMinorSum += event.amountMinor;
      existing.amountUsdSum += event.amountUsdMinor;
      existing.approvedUsdSum += isApproved ? event.amountUsdMinor : 0;
    } else {
      minuteMap.set(key, {
        bucket,
        merchantId: event.merchantId,
        providerId: event.providerId,
        country: event.country,
        paymentMethod: event.paymentMethod,
        issuerId: event.issuerId,
        attempts: 1,
        approved: isApproved ? 1 : 0,
        amountMinorSum: event.amountMinor,
        amountUsdSum: event.amountUsdMinor,
        approvedUsdSum: isApproved ? event.amountUsdMinor : 0,
      });
    }

    if (event.status === "DECLINED") {
      const declineCode = event.declineCode;
      if (!declineCode) {
        // The contract's .refine() should make this unreachable in
        // production; guarded here because aggregateDeltas is a pure
        // function that must not silently swallow an invariant violation.
        throw new Error(
          `DECLINED event ${event.transactionId} has no declineCode`,
        );
      }

      const declineKey = declineCellKey(bucket, event, declineCode);
      const existingDecline = declineMap.get(declineKey);
      if (existingDecline) {
        existingDecline.count += 1;
      } else {
        declineMap.set(declineKey, {
          bucket,
          merchantId: event.merchantId,
          providerId: event.providerId,
          country: event.country,
          paymentMethod: event.paymentMethod,
          issuerId: event.issuerId,
          declineCode,
          count: 1,
        });
      }
    }
  }

  return {
    minuteDeltas: [...minuteMap.values()],
    declineDeltas: [...declineMap.values()],
  };
}

export async function processBatch(
  events: TransactionEvent[],
): Promise<{ insertedCount: number }> {
  return db.transaction(async (tx) => {
    const insertedIds = await insertTransactions(tx, events);
    const newEvents = events.filter((event) => insertedIds.has(event.transactionId));
    const { minuteDeltas, declineDeltas } = aggregateDeltas(newEvents);

    await upsertRollupMinute(tx, minuteDeltas);
    await upsertRollupDeclinesMinute(tx, declineDeltas);

    return { insertedCount: insertedIds.size };
  });
}
