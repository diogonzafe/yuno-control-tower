DROP INDEX IF EXISTS "ix_incident_embedding";
--> statement-breakpoint
ALTER TABLE "incidents" DROP COLUMN IF EXISTS "embedding";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigation_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"status" text NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "investigation_runs_actor_check" CHECK ("investigation_runs"."actor" IN ('agent','fallback')),
	CONSTRAINT "investigation_runs_status_check" CHECK ("investigation_runs"."status" IN ('running','completed','failed','timed_out','exhausted'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_incident_id_incidents_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("incident_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_investigation_runs_incident_started" ON "investigation_runs" USING btree ("incident_id","started_at");
--> statement-breakpoint
ALTER TABLE "investigation_steps" RENAME TO "investigation_steps_legacy";
--> statement-breakpoint
CREATE TABLE "investigation_steps" (
	"run_id" uuid NOT NULL,
	"step_no" smallint NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"tool_args" jsonb NOT NULL,
	"tool_result" jsonb,
	"status" text NOT NULL,
	"error_code" text,
	"decision_summary" text,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "investigation_steps_run_id_step_no_pk" PRIMARY KEY("run_id","step_no"),
	CONSTRAINT "uq_investigation_steps_tool_call" UNIQUE("tool_call_id"),
	CONSTRAINT "investigation_steps_status_check" CHECK ("investigation_steps"."status" IN ('completed','failed')),
	CONSTRAINT "investigation_steps_outcome_check" CHECK (
		(
			"investigation_steps"."status" = 'completed'
			AND "investigation_steps"."tool_result" IS NOT NULL
			AND "investigation_steps"."error_code" IS NULL
		)
		OR (
			"investigation_steps"."status" = 'failed'
			AND "investigation_steps"."error_code" IS NOT NULL
		)
	)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigation_steps" ADD CONSTRAINT "investigation_steps_run_id_investigation_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."investigation_runs"("run_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
WITH legacy_runs AS (
	SELECT DISTINCT
		(
			substring(md5("incident_id"::text || ':' || "actor") from 1 for 8)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 9 for 4)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 13 for 4)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 17 for 4)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 21 for 12)
		)::uuid AS "legacy_run_id",
		"incident_id",
		"actor",
		min("created_at") OVER (PARTITION BY "incident_id", "actor") AS "started_at",
		max("created_at") OVER (PARTITION BY "incident_id", "actor") AS "completed_at"
	FROM "investigation_steps_legacy"
)
INSERT INTO "investigation_runs" (
	"run_id",
	"incident_id",
	"actor",
	"status",
	"model_id",
	"prompt_version",
	"started_at",
	"completed_at",
	"failure_code"
)
SELECT
	"legacy_run_id",
	"incident_id",
	"actor",
	'completed',
	NULL,
	NULL,
	"started_at",
	"completed_at",
	NULL
FROM "legacy_runs";
--> statement-breakpoint
WITH legacy_steps AS (
	SELECT
		(
			substring(md5("incident_id"::text || ':' || "actor") from 1 for 8)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 9 for 4)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 13 for 4)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 17 for 4)
			|| '-'
			|| substring(md5("incident_id"::text || ':' || "actor") from 21 for 12)
		)::uuid AS "legacy_run_id",
		"step_no",
		"tool_name",
		"tool_args",
		"tool_result",
		"reasoning",
		"created_at"
	FROM "investigation_steps_legacy"
)
INSERT INTO "investigation_steps" (
	"run_id",
	"step_no",
	"tool_call_id",
	"tool_name",
	"tool_args",
	"tool_result",
	"status",
	"error_code",
	"decision_summary",
	"created_at",
	"completed_at"
)
SELECT
	"legacy_run_id",
	"step_no",
	'legacy-' || "legacy_run_id"::text || '-' || "step_no"::text,
	"tool_name",
	"tool_args",
	"tool_result",
	'completed',
	NULL,
	"reasoning",
	"created_at",
	"created_at"
FROM "legacy_steps";
--> statement-breakpoint
DROP TABLE "investigation_steps_legacy";
