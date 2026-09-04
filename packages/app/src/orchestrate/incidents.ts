import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { EvidenceObject } from "@control-tower/contracts";
import { db as defaultDatabase } from "../db/client.js";
import { incidents } from "../db/schema.js";
import { compatible, specificity, type Cell } from "./cell.js";

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
    // The fingerprint is derived from exactly the two fields below it, so it
    // tracks them. It stopped being the incident's identity when findLiveIncident
    // took that job, and leaving it frozen at the opening window would make the
    // row disagree with itself — and would file a sharpened incident under the
    // coarse signature its first minute happened to produce, which is the
    // signature memory.ts then fails to recall it by (DD15).
    fingerprint: evidence.fingerprint,
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

type LiveIncident = { incidentId: string; dimensions: unknown; diagnosisSource: string | null };

/**
 * Which live incident this window's evidence is about.
 *
 * Not the fingerprint, and not any other exact key. Every level of the
 * diagnosis behind such a key is re-estimated from one minute of rollups on
 * every tick — the causal cell by the concentration band in `parsimony.ts`, the
 * dominant decline code by the Wilson bound in `decline-mix.ts` — so the key
 * churns while the fault stands still, and each churn retires a live incident
 * and opens a replacement three windows later. Measured on the outage of
 * 2026-09-04 17:19-18:02: one cell flat at ~13% with ~35 attempts a minute for
 * 44 minutes produced seven incidents, all carrying the same `started_at`.
 *
 * The stable question is containment, not equality: a diagnosis belongs to the
 * live incident whose cell it does not contradict. Two simultaneous causes under
 * one root stay two incidents, because their cells disagree on a dimension both
 * name (spec.md §4 criterion 5); and the narrowest match wins, so the
 * merchant-wide INCONCLUSIVE reading of an ongoing fault updates the incident
 * that names it precisely instead of opening a third one.
 *
 * `fingerprint` is untouched by any of this. It stays cell + dominant code,
 * which is what DD15 recalls a past incident by (memory.ts).
 */
async function findLiveIncident(
  database: Database,
  evidence: EvidenceObject,
): Promise<LiveIncident | undefined> {
  const { merchantId, country } = evidence.dimensions;
  const rooted = merchantId !== undefined && country !== undefined;

  const rows = await database
    .select({
      incidentId: incidents.incidentId,
      dimensions: incidents.dimensions,
      diagnosisSource: sql<string | null>`${incidents.evidence}->>'diagnosisSource'`,
    })
    .from(incidents)
    .where(
      and(
        ne(incidents.status, "resolved"),
        // DD17 fixes merchant and country on every root, so this is the entire
        // candidate set and it is a handful of rows. An evidence object with no
        // root cannot be placed by its cell at all, and keeps the exact key.
        rooted
          ? sql`${incidents.dimensions}->>'merchantId' = ${merchantId} and ${incidents.dimensions}->>'country' = ${country}`
          : eq(incidents.fingerprint, evidence.fingerprint),
      ),
    )
    .orderBy(desc(incidents.detectedAt));

  if (!rooted) return rows[0];

  // Array.prototype.sort is stable, so among equally specific matches the most
  // recently confirmed one stays first, where `orderBy` left it.
  return rows
    .filter((row) => compatible(row.dimensions as Cell, evidence.dimensions))
    .sort((a, b) => specificity(b.dimensions as Cell) - specificity(a.dimensions as Cell))[0];
}

export function createIncidentWriter(database: Database = defaultDatabase): IncidentWriter {
  return {
    async openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert> {
      const existing = await findLiveIncident(database, evidence);

      if (existing) {
        // A wider view of a fault is evidence that it is still running, not a
        // better diagnosis of it. The root-level INCONCLUSIVE branch of
        // runDiagnosis covers every cell under the merchant, so letting it
        // write here replaced a cell the peel had named with the merchant it
        // sits in — observed live on 2026-09-04 at 21:23, where an incident
        // that had read `stripe x itau` for twenty minutes stopped naming a
        // culprit at all. Its measured columns describe the wider slice too, so
        // taking them would leave the row naming one cell and costing another.
        //
        // Only the marker lifecycle.ts reads as "still live" survives, which is
        // exactly what this reading proves.
        if (specificity(existing.dimensions as Cell) > specificity(evidence.dimensions)) {
          await database
            .update(incidents)
            .set({ detectedAt: new Date(evidence.windowBucket), status: "monitoring" })
            .where(eq(incidents.incidentId, existing.incidentId));
          return { incidentId: existing.incidentId, status: "monitoring" };
        }

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
        .select({
          dimensions: incidents.dimensions,
          diagnosisSource: sql<string | null>`${incidents.evidence}->>'diagnosisSource'`,
        })
        .from(incidents)
        .where(eq(incidents.incidentId, input.incidentId))
        .limit(1);

      // A live incident can be investigated more than once — the coordinator's
      // `investigated` set lives in process memory, so every restart re-opens
      // every incident still down. When the first run succeeds and a later one
      // times out, that later run's fallback arrives holding beam_search
      // evidence for a row that already has the agent's. Taking it would undo
      // a finished investigation, so the whole triple is dropped: evidence,
      // narrative and playbook were written together from one object and stay
      // together (rules.md §4 — the text may not cite a number absent from the
      // evidence), and what is already on the row is the better matched pair.
      if (row?.diagnosisSource === "agent" && input.evidence.diagnosisSource === "beam_search") {
        return;
      }

      // Peeling can put two evidence objects under one signal, each with its
      // own incident (spec.md §4 criterion 5). The agent picks its cell out of
      // the same candidate list, so it can settle on a sibling's — and that
      // object belongs to the sibling's row, not this one. Measured columns
      // stay untouched either way: the narrator verbalizes, it never recomputes
      // (rules.md §3 boundary #2).
      //
      // The test is the same containment openOrUpdate matches on. Comparing
      // fingerprints here rejected the agent's own object whenever the dominant
      // code moved between the tick that opened the row and the investigation
      // that finished after it — a sibling's cell contradicts this one, a
      // restated code does not.
      const enriches =
        row !== undefined && compatible(row.dimensions as Cell, input.evidence.dimensions);

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
