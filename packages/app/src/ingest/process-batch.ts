import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { insertTransactions } from "./insert-transactions";
import { upsertRollupDeclinesMinute, upsertRollupMinute } from "./upsert-rollups";
import { aggregateDeltas } from "./rollup";

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
