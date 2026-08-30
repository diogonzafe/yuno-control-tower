import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  AgentDiagnosis,
  NarrativeOutput,
  SimilarIncident,
  type EvidenceObject,
  type InvestigationRequestV1,
} from "@control-tower/contracts";
import { InMemoryInvestigationAuditStore } from "../agent/audit.js";
import { loadAgentConfig } from "../agent/config.js";
import { runInvestigation } from "../agent/investigator.js";
import { renderNarratives } from "../agent/narrator.js";
import { matchRecommendation } from "../agent/playbooks.js";
import { createDeterministicInvestigationDataSource } from "../agent/tools.js";
import { runDetectionTick } from "../detect/tick.js";
import type { PersistenceState } from "../detect/persistence.js";
import type { RollupRow, RoutingCoverage } from "../detect/types.js";
import { buildEvidence } from "../diagnose/evidence.js";
import { runDiagnosis } from "../diagnose/run.js";
import { DECLINE_CATALOG, DIAGNOSE_MERCHANTS, brCardGrid } from "../diagnose/fixtures.js";
import { db } from "../db/client.js";
import { incidents } from "../db/schema.js";
import { createIncidentWriter } from "./incidents.js";
import { createLifecycle } from "./lifecycle.js";
import { createIncidentMemory } from "./memory.js";

// rules.md §4: the agent layer is proven against a real model, never mocked
// layer by layer. Everything below it is proven against the real Postgres.
// This file is the only place where the whole chain — detect, diagnose, open,
// investigate, narrate, enrich, resolve, recall — runs end to end with nothing
// stubbed, which is the only way to find out that two stages disagree on a
// shape that each one's unit test mocks its own way.
const hasKey = Boolean(process.env.OPENAI_API_KEY);

// The epoch, deliberately: this suite writes to the shared production-shape
// database, which holds ~90k real retroactive rows. A 1970 bucket is a minute
// no real or demo-generated transaction can ever fall into, and it is also what
// keeps step 7 harmless — a reconcile at a 1970 bucket computes a negative
// quiet-window count for every incident detected in this decade, so it can
// physically only ever touch a row this kind of test opened.
function bucketAt(minute: number): string {
  return new Date(Date.UTC(1970, 0, 1, 0, minute)).toISOString();
}

// Three consecutive minutes, because PERSISTENCE_WINDOWS = 3 and the point of
// driving the real detector is that the third window is the one that confirms.
const BUCKETS = [bucketAt(0), bucketAt(1), bucketAt(2)];
const DETECTED_AT = BUCKETS[2]!;
// RESOLVE_AFTER_QUIET_WINDOWS = 3, counted from detected_at. Kept as early as
// that arithmetic allows, so this reconcile cannot reach the 00:10-and-later
// incidents the other 1970-bucket suites open when vitest runs them in parallel.
const RESOLVE_BUCKET = bucketAt(5);

const COVERAGE: RoutingCoverage = ["stripe", "adyen", "mercado_pago"].map((providerId) => ({
  providerId,
  country: "BR",
  paymentMethod: "CARD",
}));

// The same nine-cell BR/CARD grid the diagnosis fixtures use, repeated in each
// of the three minutes: adyen x itau at 300/30, every sibling at 100/95, at the
// fixture's own 100 USD ticket.
//
// This ticket used to be rescaled down to 5 USD, because 900 attempts of a
// 100 USD ticket puts costUsdPerMin past 10^6 and incidents.priority_score was
// numeric(10,4) — the INSERT died with "numeric field overflow" before a single
// assertion ran. The column is numeric(20,4) now (migration 0004), so the
// expensive case is the one this suite proves.
const ALL_ROWS: RollupRow[] = BUCKETS.flatMap((bucket) => brCardGrid(bucket));

const created: string[] = [];

afterAll(async () => {
  if (created.length > 0) {
    // Scoped to the exact ids this suite generated — never a broad delete.
    await db.delete(incidents).where(inArray(incidents.incidentId, created));
    created.length = 0;
  }
});

// The investigator reads rollups through the same interface the production
// RollupSource implements, so the deterministic data source is fed the fixture
// grid bucket by bucket rather than handed one flat array for every question.
const dataSource = createDeterministicInvestigationDataSource({
  source: {
    getWindowRollups: async (bucket) => ALL_ROWS.filter((row) => row.bucket === bucket),
    getHistory: async (fromBucket, toBucket) =>
      ALL_ROWS.filter((row) => row.bucket >= fromBucket && row.bucket < toBucket),
  },
  declineSource: {
    getWindowDeclines: async () => [],
    getHistory: async () => [],
  },
  loadMerchants: async () => DIAGNOSE_MERCHANTS,
  loadCoverage: async () => COVERAGE,
  loadDeclineCatalog: async () => DECLINE_CATALOG,
});

describe.skipIf(!hasKey)("control tower full flow against a real model and the real database", () => {
  it(
    "detects, diagnoses, opens, investigates, narrates, resolves and recalls one incident",
    { timeout: 180_000 },
    async () => {
      // ---------------------------------------------------------------------
      // 1. Detection. The real tick, three times, carrying prevState forward.
      // ---------------------------------------------------------------------
      let state: PersistenceState = new Map();
      let tick: ReturnType<typeof runDetectionTick> | undefined;

      for (let index = 0; index < BUCKETS.length; index += 1) {
        const bucket = BUCKETS[index]!;
        tick = runDetectionTick({
          bucket,
          windowRows: ALL_ROWS.filter((row) => row.bucket === bucket),
          history: ALL_ROWS.filter((row) => row.bucket < bucket),
          merchants: DIAGNOSE_MERCHANTS,
          coverage: COVERAGE,
          prevState: state,
        });
        state = tick.nextState;
        // Three-window persistence is the behaviour, not a formality: a drop
        // seen only twice must still be silent.
        if (index < BUCKETS.length - 1) expect(tick.signals).toEqual([]);
      }

      const signals = tick!.signals;
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) {
        expect(signal.consecutiveWindows).toBe(3);
        expect(signal.windowBucket).toBe(DETECTED_AT);
      }

      // The root signal is what an investigation is scoped to (DD17): several
      // signals collapse onto one merchant x country incident.
      const rootSignal = signals.find(
        (signal) =>
          signal.dimensions.providerId === undefined && signal.dimensions.issuerId === undefined,
      );
      expect(rootSignal, "the absolute trigger must confirm the merchant root").toBeDefined();

      // ---------------------------------------------------------------------
      // 2. Diagnosis, from the signals the detector actually emitted.
      // ---------------------------------------------------------------------
      const diagnoses = runDiagnosis({
        signals,
        windowBucket: DETECTED_AT,
        rollups: ALL_ROWS,
        declines: [],
        declineHistory: [],
        merchants: DIAGNOSE_MERCHANTS,
        coverage: COVERAGE,
        catalog: DECLINE_CATALOG,
      });
      const diagnosis = diagnoses[0];
      expect(diagnosis, "the peeling loop must name a causal cell").toBeDefined();
      expect(diagnosis!.confidence).toBe("CONFIRMED");
      expect(diagnosis!.cell.providerId).toBe("adyen");
      expect(diagnosis!.cell.issuerId).toBe("itau");
      // DD8: the retro scan, not the detection minute, is the incident's start.
      expect(diagnosis!.startedAt).toBe(BUCKETS[0]);

      const built = buildEvidence({
        diagnosis: diagnosis!,
        rows: ALL_ROWS,
        diagnosisSource: "beam_search",
      });
      // The natural fingerprint is a cell key every run of this fixture shares.
      // A random one keeps parallel runs — and the real data — out of each
      // other's way, while leaving every measured field exactly as built.
      const fingerprint = `test-${randomUUID()}`;
      const evidence: EvidenceObject = { ...built, fingerprint };
      const recommendation = matchRecommendation(diagnosis!);

      // Steps 3 to 8 run inside one transaction, and not for speed: the app's
      // own process (src/run.ts) may be running against this same database, and
      // its per-tick lifecycle.reconcile at a present-day bucket sees any 1970
      // incident as quiet for fifty-odd years and resolves it. An uncommitted
      // row is invisible to that process, so the incident this test opens can
      // only be moved by this test. Nothing about the assertions is softened by
      // it — every statement below is real SQL against real constraints, which
      // is exactly how the priority_score ceiling above was found.
      await db.transaction(async (transaction) => {
        // Drizzle types a transaction handle separately from the database
        // handle even though every method these three factories call exists on
        // both; the cast is what lets the production code run unmodified here.
        const scoped = transaction as unknown as typeof db;

        // -------------------------------------------------------------------
        // 3. Incident creation. A row really lands in Postgres.
        // -------------------------------------------------------------------
        const writer = createIncidentWriter(scoped);
        const opened = await writer.openOrUpdate(evidence);
        created.push(opened.incidentId);
        expect(opened.status).toBe("open");

        const [afterOpen] = await scoped
          .select()
          .from(incidents)
          .where(eq(incidents.incidentId, opened.incidentId));
        expect(afterOpen?.status).toBe("open");
        expect(afterOpen?.fingerprint).toBe(fingerprint);
        expect(afterOpen?.detectedAt.toISOString()).toBe(DETECTED_AT);
        expect(afterOpen?.startedAt.toISOString()).toBe(BUCKETS[0]);
        expect(afterOpen?.resolvedAt).toBeNull();
        expect(afterOpen?.narrativeOps).toBeNull();
        expect(afterOpen?.narrativeExec).toBeNull();

        // -------------------------------------------------------------------
        // 4. Investigation with a real model. It is allowed to fail.
        // -------------------------------------------------------------------
        const config = loadAgentConfig();
        const runId = randomUUID();
        const request: InvestigationRequestV1 = {
          schemaVersion: "1",
          runId,
          source: "detector_orchestrator",
          trigger: rootSignal!,
          context: {
            merchantId: "BR_STORE_01",
            detectedAt: DETECTED_AT,
            rootDimensions: { merchantId: "BR_STORE_01", country: "BR" },
            similarIncidents: [],
          },
        };
        // The real audit store, not a stub. The Postgres one is deliberately
        // not used: its steps carry a foreign key to investigation_runs, and
        // this suite is only allowed to delete the incidents it created.
        const auditStore = new InMemoryInvestigationAuditStore(runId, "agent");

        const result = await runInvestigation({ request, config, dataSource, auditStore });
        const trail = await auditStore.getTrail();

        // rules.md §3 boundary #3. A non-deterministic model against a strict
        // schema can legitimately come back FAILED, and a suite that goes red
        // for that is a suite the team deletes. Both branches are asserted
        // here; what is never allowed either way is a half-written incident,
        // and that is checked below on the row itself.
        if (result.outcome === "COMPLETED") {
          expect(() => AgentDiagnosis.parse(result.diagnosis)).not.toThrow();
          expect(result.toolCallsUsed).toBeGreaterThan(0);
          expect(result.toolCallsUsed).toBeLessThanOrEqual(config.maxToolCalls);
          expect(trail.steps.length).toBe(result.toolCallsUsed);
          // Every call the model made had to carry a public DecisionContext.
          for (const step of trail.steps) {
            expect(step.decisionTag).toBeTruthy();
            expect(step.decisionSummary).toBeTruthy();
          }
          expect(trail.steps.map((step) => step.stepNo)).toEqual(
            trail.steps.map((_, index) => index + 1),
          );
        } else {
          // A failure is a classified failure, never an exception escaping into
          // the orchestrator, and the trail still says how far it got.
          expect(result.failureCode).toBeTruthy();
          expect(result.runId).toBe(runId);
          expect(trail.steps.length).toBeLessThanOrEqual(config.maxToolCalls);
        }

        // -------------------------------------------------------------------
        // 5. Narration with a real model. renderNarratives degrades to the
        //    deterministic template rather than throwing, so it always returns.
        // -------------------------------------------------------------------
        const narrative = await renderNarratives(config, { evidence, recommendation });
        expect(() => NarrativeOutput.parse(narrative)).not.toThrow();
        expect(narrative.operations.length).toBeGreaterThan(0);
        expect(narrative.executive.length).toBeGreaterThan(0);

        // rules.md §3 boundary #2, against a real model: every number printed
        // has to exist in the closed evidence object. A rate stored as 0.51 may
        // be spoken as 51 — that is a reading of the same field, not a new
        // number. Reaching this point at all means renderNarratives' own guard
        // already held on both outputs; this re-proves it independently.
        const flat = JSON.stringify(evidence);
        const printed = [
          ...(narrative.operations.match(/-?\d+(?:\.\d+)?/g) ?? []),
          ...(narrative.executive.match(/-?\d+(?:\.\d+)?/g) ?? []),
        ];
        for (const value of printed) {
          const asPercent = Number(value) / 100;
          const present =
            flat.includes(value) ||
            (Number.isFinite(asPercent) && flat.includes(asPercent.toString()));
          expect(present, `narrative printed ${value}, absent from the evidence`).toBe(true);
        }

        // This test passes down either branch by design, so the branch it
        // actually took is the one thing a green run would otherwise hide.
        // TEMPLATE means both narrator models were refused or broke boundary
        // #2 and the deterministic wording took over — still a pass, but the
        // number worth watching over a week of runs.
        console.log(
          `[full-flow] investigation=${result.outcome}` +
            `${result.outcome === "FAILED" ? `(${result.failureCode})` : ""}` +
            ` narration=${narrative.operations.startsWith("Conversion fell to ") ? "TEMPLATE" : "MODEL"}`,
        );

        // -------------------------------------------------------------------
        // 6. Enrichment. The narrator verbalizes; it never recomputes.
        // -------------------------------------------------------------------
        await writer.attachNarrative({
          incidentId: opened.incidentId,
          evidence,
          narrativeOps: narrative.operations,
          narrativeExec: narrative.executive,
          playbookId: recommendation?.playbookId ?? null,
        });

        const [afterNarrative] = await scoped
          .select()
          .from(incidents)
          .where(eq(incidents.incidentId, opened.incidentId));
        // Complete either way: narrated by the model if it cooperated, by the
        // deterministic template if it did not, but never left half-written.
        expect(afterNarrative?.narrativeOps).toBe(narrative.operations);
        expect(afterNarrative?.narrativeExec).toBe(narrative.executive);
        expect((afterNarrative?.narrativeOps ?? "").length).toBeGreaterThan(0);
        expect((afterNarrative?.narrativeExec ?? "").length).toBeGreaterThan(0);
        expect(afterNarrative?.playbookId).toBe(recommendation?.playbookId ?? null);
        // No measured column moved.
        expect(afterNarrative?.currentRate).toBe(afterOpen?.currentRate);
        expect(afterNarrative?.baselineRate).toBe(afterOpen?.baselineRate);
        expect(afterNarrative?.costUsdMinor).toBe(afterOpen?.costUsdMinor);
        expect(afterNarrative?.costUsdPerMin).toBe(afterOpen?.costUsdPerMin);
        expect(afterNarrative?.lostApprovals).toBe(afterOpen?.lostApprovals);
        expect(afterNarrative?.priorityScore).toBe(afterOpen?.priorityScore);
        expect(afterNarrative?.status).toBe(afterOpen?.status);
        expect(afterNarrative?.detectedAt.toISOString()).toBe(
          afterOpen?.detectedAt.toISOString(),
        );

        // -------------------------------------------------------------------
        // 7. Lifecycle. Three quiet windows after detected_at, with no evidence
        //    gap for the cell, the incident is called recovered.
        // -------------------------------------------------------------------
        const transitions = await createLifecycle(scoped).reconcile({
          bucket: RESOLVE_BUCKET,
          evidenceGaps: [],
        });
        expect(transitions.resolve).toContain(opened.incidentId);
        expect(transitions.inconclusive).not.toContain(opened.incidentId);

        const [afterResolve] = await scoped
          .select()
          .from(incidents)
          .where(eq(incidents.incidentId, opened.incidentId));
        expect(afterResolve?.status).toBe("resolved");
        expect(afterResolve?.resolvedAt?.toISOString()).toBe(RESOLVE_BUCKET);
        // Resolving is a status change, not a rewrite of what was measured, and
        // it does not throw the narrative away either.
        expect(afterResolve?.currentRate).toBe(afterOpen?.currentRate);
        expect(afterResolve?.costUsdMinor).toBe(afterOpen?.costUsdMinor);
        expect(afterResolve?.narrativeOps).toBe(narrative.operations);

        // -------------------------------------------------------------------
        // 8. Memory. The lifecycle manufactured the history the memory reads.
        // -------------------------------------------------------------------
        const memory = createIncidentMemory(scoped);
        const recalled = await memory.recallByFingerprint({ fingerprint });
        expect(recalled).toHaveLength(1);
        const similar = recalled[0]!;
        expect(() => SimilarIncident.parse(similar)).not.toThrow();
        expect(similar.incidentId).toBe(opened.incidentId);
        expect(similar.fingerprint).toBe(fingerprint);
        // The summary is built from columns only — model-written text
        // re-entering as evidence would launder invention into fact.
        expect(similar.summary).toContain(BUCKETS[0]);
        expect(similar.summary).toContain(RESOLVE_BUCKET);
        expect(similar.summary).not.toContain(narrative.operations);
        if (recommendation) {
          expect(similar.rootCauseDimension).toBe("issuer");
        }

        // Excluding the incident itself is the "what happened last time" call,
        // and there is no earlier history behind this one.
        const excluded = await memory.recallByFingerprint({
          fingerprint,
          excludeIncidentId: opened.incidentId,
        });
        expect(excluded).toEqual([]);
      });
    },
  );
});
