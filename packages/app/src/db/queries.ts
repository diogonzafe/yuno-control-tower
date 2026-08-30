import { EvidenceObject } from "@control-tower/contracts";
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { DeclineCode, DeclineRollupRow } from "../diagnose/types";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "../detect/types";
import { db } from "./client";
import { declineCodes, incidents, issuerBanks, merchants, providers, rollupDeclinesMinute, rollupMinute, routingCoverage } from "./schema";

export interface RollupSource {
  getWindowRollups(bucket: string): Promise<RollupRow[]>;
  getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]>;
}

function toRollupRow(row: typeof rollupMinute.$inferSelect): RollupRow {
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

export async function getWindowRollups(bucket: string): Promise<RollupRow[]> {
  const rows = await db.select().from(rollupMinute).where(eq(rollupMinute.bucket, new Date(bucket)));
  return rows.map(toRollupRow);
}

export async function getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]> {
  const rows = await db
    .select()
    .from(rollupMinute)
    .where(and(gte(rollupMinute.bucket, new Date(fromBucket)), lt(rollupMinute.bucket, new Date(toBucket))));
  return rows.map(toRollupRow);
}

function toDeclineRow(row: typeof rollupDeclinesMinute.$inferSelect): DeclineRollupRow {
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

export async function getDeclineRollups(fromBucket: string, toBucket: string): Promise<DeclineRollupRow[]> {
  const rows = await db
    .select()
    .from(rollupDeclinesMinute)
    .where(and(gte(rollupDeclinesMinute.bucket, new Date(fromBucket)), lte(rollupDeclinesMinute.bucket, new Date(toBucket))));
  return rows.map(toDeclineRow);
}

export async function getMerchantConfigs(): Promise<MerchantConfig[]> {
  const rows = await db.select().from(merchants);
  return rows.map((row) => ({
    merchantId: row.merchantId,
    expectedConversion: Number(row.expectedConversion),
    minMaterialDropPp: Number(row.minMaterialDropPp),
  }));
}

export async function getRoutingCoverage(): Promise<RoutingCoverage> {
  const rows = await db.select().from(routingCoverage);
  return rows.map((row) => ({ providerId: row.providerId, country: row.country, paymentMethod: row.paymentMethod }));
}

export async function getDeclineCodeCatalog(): Promise<DeclineCode[]> {
  const rows = await db.select().from(declineCodes);
  return rows.map((row) => ({
    code: row.code,
    paymentMethod: row.paymentMethod as DeclineCode["paymentMethod"],
    family: row.family as DeclineCode["family"],
    baselineShare: Number(row.baselineShare),
    diagnostic: row.diagnostic,
  }));
}

export type IncidentRow = {
  incidentId: string;
  fingerprint: string;
  status: string;
  startedAt: string;
  detectedAt: string;
  resolvedAt: string | null;
  costUsdPerMin: number;
  evidence: EvidenceObject;
};

// The API layer's read path for the incident feed: `evidence` already holds
// everything the panel shows (drill-down trail, decline mix, echoes, cost),
// so this is the only incident query the web app needs.
export async function getIncidents(limit = 100): Promise<IncidentRow[]> {
  // Explicit columns, not select(): the live table predates schema.ts's
  // pgvector `embedding` column, and `select *` would fail on it.
  const rows = await db
    .select({
      incidentId: incidents.incidentId,
      fingerprint: incidents.fingerprint,
      status: incidents.status,
      startedAt: incidents.startedAt,
      detectedAt: incidents.detectedAt,
      resolvedAt: incidents.resolvedAt,
      costUsdPerMin: incidents.costUsdPerMin,
      evidence: incidents.evidence,
    })
    .from(incidents)
    .orderBy(desc(incidents.detectedAt))
    .limit(limit);
  return rows.map((row) => ({
    incidentId: row.incidentId,
    fingerprint: row.fingerprint,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    costUsdPerMin: row.costUsdPerMin,
    evidence: EvidenceObject.parse(row.evidence),
  }));
}

export type ProviderMinutePoint = { bucket: string; providerId: string; attempts: number; approved: number };

// Live conversion-by-provider series for the chart: one row per
// (bucket, provider) pair, summed across every merchant/country/method/issuer.
export async function getProviderSeries(sinceBucket: string): Promise<ProviderMinutePoint[]> {
  const rows = await db
    .select({
      bucket: rollupMinute.bucket,
      providerId: rollupMinute.providerId,
      attempts: sql<string>`sum(${rollupMinute.attempts})`,
      approved: sql<string>`sum(${rollupMinute.approved})`,
    })
    .from(rollupMinute)
    .where(gte(rollupMinute.bucket, new Date(sinceBucket)))
    .groupBy(rollupMinute.bucket, rollupMinute.providerId)
    .orderBy(rollupMinute.bucket);
  return rows.map((row) => ({
    bucket: row.bucket.toISOString(),
    providerId: row.providerId,
    attempts: Number(row.attempts),
    approved: Number(row.approved),
  }));
}

export type Catalog = {
  merchants: { id: string; name: string }[];
  providers: { id: string; name: string }[];
  issuers: { id: string; name: string; country: string | null }[];
};

export async function getCatalog(): Promise<Catalog> {
  const [merchantRows, providerRows, issuerRows] = await Promise.all([
    db.select().from(merchants),
    db.select().from(providers),
    db.select().from(issuerBanks),
  ]);
  return {
    merchants: merchantRows.map((row) => ({ id: row.merchantId, name: row.name })),
    providers: providerRows.map((row) => ({ id: row.providerId, name: row.name })),
    issuers: issuerRows.map((row) => ({ id: row.issuerId, name: row.name, country: row.country })),
  };
}

export type PortfolioPoint = { bucket: string; attempts: number; approved: number };

export async function getPortfolioSeries(sinceBucket: string): Promise<PortfolioPoint[]> {
  const rows = await db
    .select({
      bucket: rollupMinute.bucket,
      attempts: sql<string>`sum(${rollupMinute.attempts})`,
      approved: sql<string>`sum(${rollupMinute.approved})`,
    })
    .from(rollupMinute)
    .where(gte(rollupMinute.bucket, new Date(sinceBucket)))
    .groupBy(rollupMinute.bucket)
    .orderBy(rollupMinute.bucket);
  return rows.map((row) => ({ bucket: row.bucket.toISOString(), attempts: Number(row.attempts), approved: Number(row.approved) }));
}
