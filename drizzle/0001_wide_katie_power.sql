CREATE TABLE IF NOT EXISTS "decline_codes" (
	"code" text NOT NULL,
	"payment_method" text NOT NULL,
	"family" text NOT NULL,
	"description" text NOT NULL,
	"baseline_share" numeric(5, 4) NOT NULL,
	"diagnostic" boolean NOT NULL,
	CONSTRAINT "decline_codes_code_payment_method_pk" PRIMARY KEY("code","payment_method"),
	CONSTRAINT "decline_codes_code_key" UNIQUE("code"),
	CONSTRAINT "decline_codes_family_check" CHECK ("decline_codes"."family" IN ('issuer','funds','fraud','credential','network','auth','merchant'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fx_rates" (
	"currency" char(3) NOT NULL,
	"rate_date" date NOT NULL,
	"usd_per_unit" numeric(18, 8) NOT NULL,
	"source" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fx_rates_currency_rate_date_pk" PRIMARY KEY("currency","rate_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incidents" (
	"incident_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"dimensions" jsonb NOT NULL,
	"dominant_decline" text,
	"status" text NOT NULL,
	"ci_low" numeric(6, 5) NOT NULL,
	"ci_high" numeric(6, 5) NOT NULL,
	"ci_level" numeric(4, 3) DEFAULT '0.95' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_at_exact" boolean DEFAULT true NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"baseline_rate" numeric(6, 5) NOT NULL,
	"current_rate" numeric(6, 5) NOT NULL,
	"lost_approvals" integer NOT NULL,
	"cost_local" jsonb,
	"cost_usd_minor" bigint NOT NULL,
	"cost_usd_per_min" bigint NOT NULL,
	"priority_score" numeric(10, 4) NOT NULL,
	"evidence" jsonb NOT NULL,
	"narrative_ops" text,
	"narrative_exec" text,
	"playbook_id" text,
	"embedding" vector(1536),
	CONSTRAINT "incidents_status_check" CHECK ("incidents"."status" IN ('open','monitoring','resolved','inconclusive'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigation_steps" (
	"incident_id" uuid NOT NULL,
	"step_no" smallint NOT NULL,
	"actor" text NOT NULL,
	"tool_name" text NOT NULL,
	"tool_args" jsonb NOT NULL,
	"tool_result" jsonb NOT NULL,
	"reasoning" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "investigation_steps_incident_id_step_no_pk" PRIMARY KEY("incident_id","step_no"),
	CONSTRAINT "investigation_steps_actor_check" CHECK ("investigation_steps"."actor" IN ('agent','fallback'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issuer_banks" (
	"issuer_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" char(2)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchants" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"expected_conversion" numeric(6, 5) NOT NULL,
	"min_material_drop_pp" numeric(4, 2) DEFAULT '3.0' NOT NULL,
	"avg_ticket_usd_minor" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playbooks" (
	"playbook_id" text PRIMARY KEY NOT NULL,
	"causal_dimension" text NOT NULL,
	"decline_family" text,
	"title" text NOT NULL,
	"action_template" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "providers" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rollup_declines_minute" (
	"bucket" timestamp with time zone NOT NULL,
	"merchant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"country" char(2) NOT NULL,
	"payment_method" text NOT NULL,
	"issuer_id" text NOT NULL,
	"decline_code" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rollup_declines_minute_bucket_merchant_id_provider_id_country_payment_method_issuer_id_decline_code_pk" PRIMARY KEY("bucket","merchant_id","provider_id","country","payment_method","issuer_id","decline_code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rollup_minute" (
	"bucket" timestamp with time zone NOT NULL,
	"merchant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"country" char(2) NOT NULL,
	"payment_method" text NOT NULL,
	"issuer_id" text NOT NULL,
	"attempts" integer NOT NULL,
	"approved" integer NOT NULL,
	"amount_minor_sum" bigint NOT NULL,
	"amount_usd_sum" bigint NOT NULL,
	"approved_usd_sum" bigint NOT NULL,
	"latency_p50_ms" integer,
	CONSTRAINT "rollup_minute_bucket_merchant_id_provider_id_country_payment_method_issuer_id_pk" PRIMARY KEY("bucket","merchant_id","provider_id","country","payment_method","issuer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routing_coverage" (
	"provider_id" text NOT NULL,
	"country" char(2) NOT NULL,
	"payment_method" text NOT NULL,
	CONSTRAINT "routing_coverage_provider_id_country_payment_method_pk" PRIMARY KEY("provider_id","country","payment_method")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"merchant_order_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"country" char(2) NOT NULL,
	"payment_method" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fx_rate" numeric(18, 8) NOT NULL,
	"fx_rate_date" date NOT NULL,
	"fx_source" text NOT NULL,
	"amount_usd_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"decline_code" text,
	"raw_decline_code" text,
	"card_brand" text,
	"card_type" text,
	"card_bin" char(6),
	"issuer_id" text DEFAULT 'NA' NOT NULL,
	"token" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transactions_status_check" CHECK ("transactions"."status" IN ('SUCCESS','DECLINED')),
	CONSTRAINT "transactions_card_type_check" CHECK ("transactions"."card_type" IN ('debit','credit')),
	CONSTRAINT "decline_code_consistency" CHECK (("transactions"."status" = 'DECLINED') = ("transactions"."decline_code" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigation_steps" ADD CONSTRAINT "investigation_steps_incident_id_incidents_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("incident_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routing_coverage" ADD CONSTRAINT "routing_coverage_provider_id_providers_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("provider_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_merchants_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("merchant_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_provider_id_providers_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("provider_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_issuer_id_issuer_banks_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuer_banks"("issuer_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_decline_code_fkey" FOREIGN KEY ("decline_code") REFERENCES "public"."decline_codes"("code") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_incident_fingerprint" ON "incidents" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_incident_embedding" ON "incidents" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_rollup_bucket" ON "rollup_minute" USING btree ("bucket" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_transactions_created_at" ON "transactions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_transactions_cube" ON "transactions" USING btree ("merchant_id","provider_id","country","payment_method","issuer_id","created_at" DESC NULLS LAST);