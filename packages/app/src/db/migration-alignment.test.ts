import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("agent audit migration", () => {
  it("creates investigation_runs and rebuilds investigation_steps from legacy data", () => {
    const sql = readFileSync(
      resolve(import.meta.dirname, "../../../..", "drizzle/0002_agent_audit_alignment.sql"),
      "utf8",
    );

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "investigation_runs"');
    expect(sql).toContain('ALTER TABLE "investigation_steps" RENAME TO "investigation_steps_legacy"');
    expect(sql).toContain('INSERT INTO "investigation_runs"');
    expect(sql).toContain('INSERT INTO "investigation_steps"');
    expect(sql).toContain('DROP TABLE "investigation_steps_legacy"');
    expect(sql).toContain('DROP INDEX IF EXISTS "ix_incident_embedding"');
    expect(sql).toContain('ALTER TABLE "incidents" DROP COLUMN IF EXISTS "embedding"');
  });

  it("extends run and step audit columns for the complete agentic module", () => {
    const sql = readFileSync(
      resolve(import.meta.dirname, "../../../..", "drizzle/0003_agentic_module_completion.sql"),
      "utf8",
    );

    expect(sql).toContain('ALTER TABLE "investigation_runs"');
    expect(sql).toContain('"request_snapshot" jsonb');
    expect(sql).toContain('"conclusion_tag" text');
    expect(sql).toContain('"supporting_step_nos" smallint[]');
    expect(sql).toContain('"decision_tag" text');
    expect(sql).toContain('"hypothesis" jsonb');
    expect(sql).toContain('"evidence_step_nos" smallint[]');
  });
});
