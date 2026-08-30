import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
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
    evidence: EvidenceObject;
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
  };
}

export function createIncidentWriter(database: Database = defaultDatabase): IncidentWriter {
  return {
    async openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert> {
      const [existing] = await database
        .select({
          incidentId: incidents.incidentId,
          diagnosisSource: sql<string | null>`${incidents.evidence}->>'diagnosisSource'`,
        })
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
          .set({
            ...measuredColumns(evidence),
            // Once attachNarrative has put the agent's object here, the tick
            // must not overwrite it with the deterministic one — the drop
            // re-confirms every minute while the incident is live, so without
            // this guard `diagnosisSource` reverts to "beam_search" within a
            // minute of every successful investigation and the panel never
            // shows an agent-sourced incident. The stored narrative was
            // written from this exact object too (rules.md §4: it may not cite
            // a number absent from it), so the pair stays together. The
            // measured columns above keep tracking the live window either way.
            ...(existing.diagnosisSource === "agent" ? {} : { evidence }),
            status: "monitoring",
          })
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
        evidence,
      });
      return { incidentId, status: "open" };
    },

    async attachNarrative(input) {
      // The flight log "Who assembles the EvidenceObject" puts `orchestrate/`
      // in charge of persisting the finished object verbatim, and the agent
      // path produces a second one: same assembly point (diagnose/evidence.ts),
      // same numbers, but carrying `diagnosisSource: "agent"` and the trail the
      // investigator actually walked instead of the replayed deterministic one.
      // Writing only the narrative here left that object in memory and on SSE
      // and never in the column the UI reads, so every incident rendered as a
      // deterministic one no matter how the investigation went.
      const [row] = await database
        .select({ fingerprint: incidents.fingerprint })
        .from(incidents)
        .where(eq(incidents.incidentId, input.incidentId))
        .limit(1);

      // Peeling can put two evidence objects under one signal, each with its
      // own incident (spec.md §4 criterion 5). The agent picks its cell out of
      // the same candidate list, so it can settle on a sibling's — and that
      // object belongs to the sibling's row, not this one. Measured columns
      // stay untouched either way: the narrator verbalizes, it never recomputes
      // (rules.md §3 boundary #2).
      const enriches = row?.fingerprint === input.evidence.fingerprint;

      await database
        .update(incidents)
        .set({
          ...(enriches ? { evidence: input.evidence } : {}),
          narrativeOps: input.narrativeOps,
          narrativeExec: input.narrativeExec,
          playbookId: input.playbookId,
        })
        .where(eq(incidents.incidentId, input.incidentId));
    },
  };
}
