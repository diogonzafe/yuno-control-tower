import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import type { EvidenceObject } from "@control-tower/contracts";
import { db as defaultDatabase } from "../db/client.js";
import { incidents } from "../db/schema.js";

type Database = typeof defaultDatabase;

export type IncidentUpsert = {
  incidentId: string;
  status: "open" | "monitoring";
};

export type IncidentWriter = {
  openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert>;
  attachNarrative(input: {
    incidentId: string;
    narrativeOps: string | null;
    narrativeExec: string | null;
    playbookId: string | null;
  }): Promise<void>;
};

// Every `numeric` column is typed as string by Drizzle (no `mode` set in
// db/schema.ts), so each one is converted explicitly. Passing a JS number here
// fails at the driver, not at the type checker.
function measuredColumns(evidence: EvidenceObject) {
  return {
    dimensions: evidence.dimensions,
    dominantDecline: evidence.dominantDecline,
    ciLow: evidence.ci.low.toString(),
    ciHigh: evidence.ci.high.toString(),
    ciLevel: evidence.ci.level.toString(),
    startedAt: new Date(evidence.startedAt),
    startedAtExact: evidence.startedAtExact,
    detectedAt: new Date(evidence.windowBucket),
    baselineRate: evidence.expectedRate.toString(),
    currentRate: evidence.observedRate.toString(),
    lostApprovals: evidence.lostApprovals,
    costLocal: evidence.costLocal,
    costUsdMinor: evidence.costUsdMinor,
    costUsdPerMin: evidence.costUsdPerMin,
    priorityScore: evidence.priorityScore.toString(),
    evidence,
  };
}

export function createIncidentWriter(database: Database = defaultDatabase): IncidentWriter {
  return {
    async openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert> {
      const [existing] = await database
        .select({ incidentId: incidents.incidentId })
        .from(incidents)
        .where(and(eq(incidents.fingerprint, evidence.fingerprint), ne(incidents.status, "resolved")))
        .orderBy(desc(incidents.detectedAt))
        .limit(1);

      if (existing) {
        // roadmap.md §5: `monitoring` updates without re-alerting, which is
        // what stops a three-hour incident from producing 36 alerts. The
        // detectedAt bump inside measuredColumns is what lifecycle.ts reads
        // as "still live".
        await database
          .update(incidents)
          .set({ ...measuredColumns(evidence), status: "monitoring" })
          .where(eq(incidents.incidentId, existing.incidentId));
        return { incidentId: existing.incidentId, status: "monitoring" };
      }

      const incidentId = randomUUID();
      await database.insert(incidents).values({
        incidentId,
        fingerprint: evidence.fingerprint,
        status: "open",
        resolvedAt: null,
        narrativeOps: null,
        narrativeExec: null,
        playbookId: null,
        ...measuredColumns(evidence),
      });
      return { incidentId, status: "open" };
    },

    async attachNarrative(input) {
      await database
        .update(incidents)
        .set({
          narrativeOps: input.narrativeOps,
          narrativeExec: input.narrativeExec,
          playbookId: input.playbookId,
        })
        .where(eq(incidents.incidentId, input.incidentId));
    },
  };
}
