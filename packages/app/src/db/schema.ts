import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ══════════════ CATALOGS ══════════════
// Mirrors context/schema.md §7. DD1-DD21 are the decision references in
// column comments below; do not diverge from them without updating that doc.

export const merchants = pgTable("merchants", {
  merchantId: text("merchant_id").primaryKey(),
  name: text("name").notNull(),
  // DD7: configured, not learned. Compared ONLY against the merchant
  // aggregate, never against a single cell (see schema.md §6).
  expectedConversion: numeric("expected_conversion", { precision: 6, scale: 5 }).notNull(),
  minMaterialDropPp: numeric("min_material_drop_pp", { precision: 4, scale: 2 })
    .notNull()
    .default("3.0"),
  avgTicketUsdMinor: bigint("avg_ticket_usd_minor", { mode: "number" }).notNull(),
});

export const providers = pgTable("providers", {
  providerId: text("provider_id").primaryKey(),
  name: text("name").notNull(),
});

export const issuerBanks = pgTable("issuer_banks", {
  issuerId: text("issuer_id").primaryKey(), // 'NA' for methods without an issuer
  name: text("name").notNull(),
  country: char("country", { length: 2 }),
});

export const declineCodes = pgTable(
  "decline_codes",
  {
    code: text("code").notNull(),
    paymentMethod: text("payment_method").notNull(), // CARD | PIX — disjoint spaces (DD21)
    family: text("family").notNull(),
    description: text("description").notNull(),
    baselineShare: numeric("baseline_share", { precision: 5, scale: 4 }).notNull(),
    diagnostic: boolean("diagnostic").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.code, t.paymentMethod] }),
    check(
      "decline_codes_family_check",
      sql`${t.family} IN ('issuer','funds','fraud','credential','network','auth','merchant')`,
    ),
    // DD21: code spaces are disjoint across CARD/PIX, so `code` alone is
    // globally unique. Required for transactions.decline_code to reference
    // this table by a single column (the raw DDL's single-column REFERENCES
    // cannot target a composite primary key without this).
    unique("decline_codes_code_key").on(t.code),
  ],
);

// combinations that actually exist
export const routingCoverage = pgTable(
  "routing_coverage",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.providerId),
    country: char("country", { length: 2 }).notNull(),
    paymentMethod: text("payment_method").notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.country, t.paymentMethod] })],
);

// DD9: series by date, not a single snapshot.
// The transaction stores the rate it used; this table is the lookup source.
export const fxRates = pgTable(
  "fx_rates",
  {
    currency: char("currency", { length: 3 }).notNull(), // ARS, MXN, BRL
    rateDate: date("rate_date").notNull(),
    usdPerUnit: numeric("usd_per_unit", { precision: 18, scale: 8 }).notNull(),
    source: text("source").notNull(), // PTAX | DOF | BCRA_A3500 | MOCK
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.rateDate] })],
);

// ══════════════ TRANSACTIONS ══════════════

export const transactions = pgTable(
  "transactions",
  {
    transactionId: uuid("transaction_id").primaryKey(),
    merchantOrderId: text("merchant_order_id").notNull(),
    // DD10: account_id and merchant_id were the same entity. Single column.
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.merchantId),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.providerId),
    country: char("country", { length: 2 }).notNull(),
    paymentMethod: text("payment_method").notNull(),

    currency: char("currency", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(), // cents, local currency
    fxRate: numeric("fx_rate", { precision: 18, scale: 8 }).notNull(), // DD9: rate used, frozen
    fxRateDate: date("fx_rate_date").notNull(), // DD9: quote date
    fxSource: text("fx_source").notNull(), // DD9: PTAX | DOF | BCRA_A3500 | MOCK
    amountUsdMinor: bigint("amount_usd_minor", { mode: "number" }).notNull(), // derived, frozen at creation

    status: text("status").notNull(),
    declineCode: text("decline_code"), // internal, part of the cube
    rawDeclineCode: text("raw_decline_code"), // network code, outside the cube

    cardBrand: text("card_brand"), // NULL on PIX
    cardType: text("card_type"),
    cardBin: char("card_bin", { length: 6 }),
    issuerId: text("issuer_id")
      .notNull()
      .default("NA")
      .references(() => issuerBanks.issuerId),
    token: text("token"),

    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.declineCode],
      foreignColumns: [declineCodes.code],
      name: "transactions_decline_code_fkey",
    }),
    check("transactions_status_check", sql`${t.status} IN ('SUCCESS','DECLINED')`),
    check("transactions_card_type_check", sql`${t.cardType} IN ('debit','credit')`),
    check(
      "decline_code_consistency",
      sql`(${t.status} = 'DECLINED') = (${t.declineCode} IS NOT NULL)`,
    ),
    index("ix_transactions_created_at").on(t.createdAt.desc()),
    index("ix_transactions_cube").on(
      t.merchantId,
      t.providerId,
      t.country,
      t.paymentMethod,
      t.issuerId,
      t.createdAt.desc(),
    ),
  ],
);

// ══════════════ ROLLUPS ══════════════

export const rollupMinute = pgTable(
  "rollup_minute",
  {
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    merchantId: text("merchant_id").notNull(),
    providerId: text("provider_id").notNull(),
    country: char("country", { length: 2 }).notNull(),
    paymentMethod: text("payment_method").notNull(),
    issuerId: text("issuer_id").notNull(),
    // DD12: card_brand and card_type are NOT cube dimensions.

    attempts: integer("attempts").notNull(),
    approved: integer("approved").notNull(),
    amountMinorSum: bigint("amount_minor_sum", { mode: "number" }).notNull(),
    amountUsdSum: bigint("amount_usd_sum", { mode: "number" }).notNull(),
    approvedUsdSum: bigint("approved_usd_sum", { mode: "number" }).notNull(),
    latencyP50Ms: integer("latency_p50_ms"),
  },
  (t) => [
    primaryKey({
      columns: [t.bucket, t.merchantId, t.providerId, t.country, t.paymentMethod, t.issuerId],
    }),
    index("ix_rollup_bucket").on(t.bucket.desc()),
  ],
);

export const rollupDeclinesMinute = pgTable(
  "rollup_declines_minute",
  {
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    merchantId: text("merchant_id").notNull(),
    providerId: text("provider_id").notNull(),
    country: char("country", { length: 2 }).notNull(),
    paymentMethod: text("payment_method").notNull(),
    issuerId: text("issuer_id").notNull(),
    declineCode: text("decline_code").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.bucket,
        t.merchantId,
        t.providerId,
        t.country,
        t.paymentMethod,
        t.issuerId,
        t.declineCode,
      ],
    }),
  ],
);

// DD7: rollup_hour and baseline_profile were REMOVED.
// Expected conversion comes from merchants.expectedConversion (absolute
// trigger) and from cross-sectional/temporal queries over rollup_minute
// (schema.md §6).

// ══════════════ INCIDENTS ══════════════

export const incidents = pgTable(
  "incidents",
  {
    incidentId: uuid("incident_id").primaryKey(),
    fingerprint: text("fingerprint").notNull(), // fixed dimensions + dominant decline
    dimensions: jsonb("dimensions").notNull(), // {"provider_id":"adyen","country":"BR"}
    dominantDecline: text("dominant_decline"),

    status: text("status").notNull(),
    // DD11: Wilson interval instead of a single probability.
    ciLow: numeric("ci_low", { precision: 6, scale: 5 }).notNull(),
    ciHigh: numeric("ci_high", { precision: 6, scale: 5 }).notNull(),
    ciLevel: numeric("ci_level", { precision: 4, scale: 3 }).notNull().default("0.95"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(), // DD8: retro scan
    startedAtExact: boolean("started_at_exact").notNull().default(true), // false = show "≈"
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    baselineRate: numeric("baseline_rate", { precision: 6, scale: 5 }).notNull(),
    currentRate: numeric("current_rate", { precision: 6, scale: 5 }).notNull(),
    lostApprovals: integer("lost_approvals").notNull(), // computed with ci_high (conservative floor)
    costLocal: jsonb("cost_local"), // {"BRL": 128400}
    costUsdMinor: bigint("cost_usd_minor", { mode: "number" }).notNull(),
    costUsdPerMin: bigint("cost_usd_per_min", { mode: "number" }).notNull(),
    priorityScore: numeric("priority_score", { precision: 10, scale: 4 }).notNull(),

    evidence: jsonb("evidence").notNull(),
    narrativeOps: text("narrative_ops"),
    narrativeExec: text("narrative_exec"),
    playbookId: text("playbook_id"),
    // DD15: pgvector for the approximate-match path; exact fingerprint stays primary.
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (t) => [
    check(
      "incidents_status_check",
      sql`${t.status} IN ('open','monitoring','resolved','inconclusive')`,
    ),
    index("ix_incident_fingerprint").on(t.fingerprint),
    index("ix_incident_embedding")
      .using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// investigation trail: feeds the UI and the technical defense
export const investigationSteps = pgTable(
  "investigation_steps",
  {
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.incidentId),
    stepNo: smallint("step_no").notNull(),
    actor: text("actor").notNull(),
    toolName: text("tool_name").notNull(),
    toolArgs: jsonb("tool_args").notNull(),
    toolResult: jsonb("tool_result").notNull(),
    reasoning: text("reasoning"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.incidentId, t.stepNo] }),
    check("investigation_steps_actor_check", sql`${t.actor} IN ('agent','fallback')`),
  ],
);

export const playbooks = pgTable("playbooks", {
  playbookId: text("playbook_id").primaryKey(),
  causalDimension: text("causal_dimension").notNull(), // provider | issuer | method | merchant
  declineFamily: text("decline_family"),
  title: text("title").notNull(),
  actionTemplate: jsonb("action_template").notNull(), // structured action, never executed
});
