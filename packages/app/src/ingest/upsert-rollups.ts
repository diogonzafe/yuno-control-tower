import { sql } from "drizzle-orm";
import { rollupDeclinesMinute, rollupMinute } from "../db/schema";
import type { Inserter } from "./insert-transactions";
import type { RollupDeclineDelta, RollupMinuteDelta } from "./rollup";

export async function upsertRollupMinute(
  dbClient: Inserter,
  deltas: RollupMinuteDelta[],
): Promise<void> {
  if (deltas.length === 0) {
    return;
  }

  await dbClient
    .insert(rollupMinute)
    .values(
      deltas.map((delta) => ({
        bucket: delta.bucket,
        merchantId: delta.merchantId,
        providerId: delta.providerId,
        country: delta.country,
        paymentMethod: delta.paymentMethod,
        issuerId: delta.issuerId,
        attempts: delta.attempts,
        approved: delta.approved,
        amountMinorSum: delta.amountMinorSum,
        amountUsdSum: delta.amountUsdSum,
        approvedUsdSum: delta.approvedUsdSum,
      })),
    )
    .onConflictDoUpdate({
      target: [
        rollupMinute.bucket,
        rollupMinute.merchantId,
        rollupMinute.providerId,
        rollupMinute.country,
        rollupMinute.paymentMethod,
        rollupMinute.issuerId,
      ],
      set: {
        attempts: sql`${rollupMinute.attempts} + excluded.attempts`,
        approved: sql`${rollupMinute.approved} + excluded.approved`,
        amountMinorSum: sql`${rollupMinute.amountMinorSum} + excluded.amount_minor_sum`,
        amountUsdSum: sql`${rollupMinute.amountUsdSum} + excluded.amount_usd_sum`,
        approvedUsdSum: sql`${rollupMinute.approvedUsdSum} + excluded.approved_usd_sum`,
      },
    });
}

export async function upsertRollupDeclinesMinute(
  dbClient: Inserter,
  deltas: RollupDeclineDelta[],
): Promise<void> {
  if (deltas.length === 0) {
    return;
  }

  await dbClient
    .insert(rollupDeclinesMinute)
    .values(
      deltas.map((delta) => ({
        bucket: delta.bucket,
        merchantId: delta.merchantId,
        providerId: delta.providerId,
        country: delta.country,
        paymentMethod: delta.paymentMethod,
        issuerId: delta.issuerId,
        declineCode: delta.declineCode,
        count: delta.count,
      })),
    )
    .onConflictDoUpdate({
      target: [
        rollupDeclinesMinute.bucket,
        rollupDeclinesMinute.merchantId,
        rollupDeclinesMinute.providerId,
        rollupDeclinesMinute.country,
        rollupDeclinesMinute.paymentMethod,
        rollupDeclinesMinute.issuerId,
        rollupDeclinesMinute.declineCode,
      ],
      set: {
        count: sql`${rollupDeclinesMinute.count} + excluded.count`,
      },
    });
}
