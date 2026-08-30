import { and, gte, lt, eq } from "drizzle-orm";
import { db } from "./client.js";
import { declineCodes, merchants, rollupDeclinesMinute, rollupMinute, routingCoverage } from "./schema.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "../detect/types.js";
import type { DeclineCode, DeclineRollupRow } from "../diagnose/types.js";

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

// SQL implementation belongs to the DB-layer branch; diagnose/ receives arrays,
// same boundary RollupSource already draws for the detector.
export interface DeclineSource {
  getWindowDeclines(bucket: string): Promise<DeclineRollupRow[]>;
  getHistory(fromBucket: string, toBucket: string): Promise<DeclineRollupRow[]>;
}

type DeclineRollupSelect = typeof rollupDeclinesMinute.$inferSelect;

function toDeclineRollupRow(row: DeclineRollupSelect): DeclineRollupRow {
  return {
    bucket: row.bucket.toISOString(),
    merchantId: row.merchantId,
    providerId: row.providerId,
    country: row.country as DeclineRollupRow["country"],
    paymentMethod: row.paymentMethod as DeclineRollupRow["paymentMethod"],
    issuerId: row.issuerId,
    declineCode: row.declineCode,
    count: row.count,
  };
}

export function createDeclineSource(): DeclineSource {
  return {
    async getWindowDeclines(bucket) {
      const rows = await db
        .select()
        .from(rollupDeclinesMinute)
        .where(eq(rollupDeclinesMinute.bucket, new Date(bucket)));
      return rows.map(toDeclineRollupRow);
    },
    async getHistory(fromBucket, toBucket) {
      const rows = await db
        .select()
        .from(rollupDeclinesMinute)
        .where(
          and(
            gte(rollupDeclinesMinute.bucket, new Date(fromBucket)),
            lt(rollupDeclinesMinute.bucket, new Date(toBucket)),
          ),
        );
      return rows.map(toDeclineRollupRow);
    },
  };
}

export async function loadDeclineCatalog(): Promise<DeclineCode[]> {
  const rows = await db
    .select({
      code: declineCodes.code,
      paymentMethod: declineCodes.paymentMethod,
      family: declineCodes.family,
      baselineShare: declineCodes.baselineShare,
      diagnostic: declineCodes.diagnostic,
    })
    .from(declineCodes);

  // Same trap as loadMerchantConfigs: numeric() without an explicit mode
  // arrives as a string, and a string baseline share would silently never
  // move a decline-mix delta.
  return rows.map((row) => ({
    code: row.code,
    paymentMethod: row.paymentMethod as DeclineCode["paymentMethod"],
    family: row.family as DeclineCode["family"],
    baselineShare: Number(row.baselineShare),
    diagnostic: row.diagnostic,
  }));
}
