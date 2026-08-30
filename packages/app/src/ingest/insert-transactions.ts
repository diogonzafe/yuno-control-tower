import type { TransactionEvent } from "@control-tower/contracts";
import { transactions } from "../db/schema";
import type { db } from "../db/client";

export type Inserter = Pick<typeof db, "insert">;

export async function insertTransactions(
  dbClient: Inserter,
  events: TransactionEvent[],
): Promise<Set<string>> {
  if (events.length === 0) {
    return new Set();
  }

  const rows = events.map((event) => ({
    transactionId: event.transactionId,
    merchantOrderId: event.merchantOrderId,
    merchantId: event.merchantId,
    providerId: event.providerId,
    country: event.country,
    paymentMethod: event.paymentMethod,
    currency: event.currency,
    amountMinor: event.amountMinor,
    // fx_rate is a plain `numeric` column — Drizzle's default mode for
    // numeric is `string`, to avoid silent float precision loss.
    fxRate: event.fxRate.toString(),
    fxRateDate: event.fxRateDate,
    fxSource: event.fxSource,
    amountUsdMinor: event.amountUsdMinor,
    status: event.status,
    declineCode: event.declineCode ?? null,
    rawDeclineCode: event.rawDeclineCode ?? null,
    cardBrand: event.cardBrand ?? null,
    cardType: event.cardType ?? null,
    cardBin: event.cardBin ?? null,
    issuerId: event.issuerId,
    token: event.token ?? null,
    latencyMs: event.latencyMs ?? null,
    createdAt: new Date(event.createdAt),
  }));

  const inserted = await dbClient
    .insert(transactions)
    .values(rows)
    .onConflictDoNothing({ target: transactions.transactionId })
    .returning({ transactionId: transactions.transactionId });

  return new Set(inserted.map((row) => row.transactionId));
}
