import { and, gte, lt, eq } from "drizzle-orm";
import { db } from "./client.js";
import { merchants, rollupMinute, routingCoverage } from "./schema.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "../detect/types.js";

// SQL implementation belongs to the DB-layer branch; the detector receives arrays.
export interface RollupSource {
  getWindowRollups(bucket: string): Promise<RollupRow[]>;
  getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]>;
}

type RollupSelect = typeof rollupMinute.$inferSelect;

// bucket is a TIMESTAMPTZ (Drizzle hands back a Date) while RollupRow.bucket is
// an ISO string, and country is char(2) while RollupRow.country is a union —
// both are narrowed here, once, at the SQL boundary, so the pure engine keeps
// receiving exactly the shape its fixtures already use.
function toRollupRow(row: RollupSelect): RollupRow {
  return {
    bucket: row.bucket.toISOString(),
    merchantId: row.merchantId,
    providerId: row.providerId,
    country: row.country as RollupRow["country"],
    paymentMethod: row.paymentMethod as RollupRow["paymentMethod"],
    issuerId: row.issuerId,
    attempts: row.attempts,
    approved: row.approved,
    amountMinorSum: row.amountMinorSum,
    amountUsdSum: row.amountUsdSum,
    approvedUsdSum: row.approvedUsdSum,
  };
}

export function createRollupSource(): RollupSource {
  return {
    async getWindowRollups(bucket) {
      const rows = await db.select().from(rollupMinute).where(eq(rollupMinute.bucket, new Date(bucket)));
      return rows.map(toRollupRow);
    },
    async getHistory(fromBucket, toBucket) {
      const rows = await db
        .select()
        .from(rollupMinute)
        .where(and(gte(rollupMinute.bucket, new Date(fromBucket)), lt(rollupMinute.bucket, new Date(toBucket))));
      return rows.map(toRollupRow);
    },
  };
}

export async function loadMerchantConfigs(): Promise<MerchantConfig[]> {
  const rows = await db
    .select({
      merchantId: merchants.merchantId,
      expectedConversion: merchants.expectedConversion,
      minMaterialDropPp: merchants.minMaterialDropPp,
    })
    .from(merchants);

  // numeric() without an explicit mode is Drizzle's string mode. Passing those
  // strings into the Wilson comparison would silently never fire.
  return rows.map((row) => ({
    merchantId: row.merchantId,
    expectedConversion: Number(row.expectedConversion),
    minMaterialDropPp: Number(row.minMaterialDropPp),
  }));
}

export async function loadRoutingCoverage(): Promise<RoutingCoverage> {
  return db
    .select({
      providerId: routingCoverage.providerId,
      country: routingCoverage.country,
      paymentMethod: routingCoverage.paymentMethod,
    })
    .from(routingCoverage);
}
