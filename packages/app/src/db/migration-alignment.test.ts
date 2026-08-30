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
});
