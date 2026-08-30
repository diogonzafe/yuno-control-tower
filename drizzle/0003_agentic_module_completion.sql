ALTER TABLE "investigation_runs"
  ALTER COLUMN "incident_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "investigation_runs"
  ADD COLUMN IF NOT EXISTS "request_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "investigation_runs"
  ADD COLUMN IF NOT EXISTS "conclusion_tag" text;
--> statement-breakpoint
ALTER TABLE "investigation_runs"
  ADD COLUMN IF NOT EXISTS "conclusion_summary" text;
--> statement-breakpoint
ALTER TABLE "investigation_runs"
  ADD COLUMN IF NOT EXISTS "supporting_step_nos" smallint[] NOT NULL DEFAULT '{}'::smallint[];
--> statement-breakpoint
ALTER TABLE "investigation_runs"
  DROP CONSTRAINT IF EXISTS "investigation_runs_conclusion_tag_check";
--> statement-breakpoint
ALTER TABLE "investigation_runs"
  ADD CONSTRAINT "investigation_runs_conclusion_tag_check"
  CHECK ("conclusion_tag" IS NULL OR "conclusion_tag" IN ('STOP_CONCLUSIVE','STOP_INCONCLUSIVE'));
--> statement-breakpoint
ALTER TABLE "investigation_steps"
  ADD COLUMN IF NOT EXISTS "decision_tag" text;
--> statement-breakpoint
ALTER TABLE "investigation_steps"
  ADD COLUMN IF NOT EXISTS "hypothesis" jsonb;
--> statement-breakpoint
ALTER TABLE "investigation_steps"
  ADD COLUMN IF NOT EXISTS "evidence_step_nos" smallint[] NOT NULL DEFAULT '{}'::smallint[];
--> statement-breakpoint
ALTER TABLE "investigation_steps"
  DROP CONSTRAINT IF EXISTS "investigation_steps_decision_tag_check";
--> statement-breakpoint
ALTER TABLE "investigation_steps"
  ADD CONSTRAINT "investigation_steps_decision_tag_check"
  CHECK (
    "decision_tag" IS NULL OR "decision_tag" IN (
      'HYPOTHESIS','DRILL_DOWN','COMPARE_HISTORY','CHECK_DECLINE_MIX',
      'VALIDATE_RESIDUAL','CONFIRM_ONSET','ESTIMATE_IMPACT'
    )
  );
