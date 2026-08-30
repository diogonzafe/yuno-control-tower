import { AgentDiagnosis, NarrativeOutput } from "@control-tower/contracts";
import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "./config.js";
import { runInvestigation } from "./investigator.js";
import { renderNarratives } from "./narrator.js";
import { matchRecommendation } from "./playbooks.js";
import { createDeterministicInvestigationDataSource } from "./tools.js";
import { InMemoryInvestigationAuditStore } from "./audit.js";
import { buildEvidence } from "../diagnose/evidence.js";
import { runDiagnosis } from "../diagnose/run.js";
import {
  BR_ROOT,
  BUCKET,
  DECLINE_CATALOG,
  DIAGNOSE_MERCHANTS,
  brCardGrid,
  confirmedDrop,
} from "../diagnose/fixtures.js";
import type { RoutingCoverage } from "../detect/types.js";

// rules.md §4, last row: the agent end-to-end test "uses a real or recorded
// (cassette) LLM, not mocked layer by layer", and runs separately from the rest
// because it is slow. Every other agent test mocks `generate`, so nothing else
// in the suite proves that Mastra's structuredOutput + tools wiring actually
// works, that the model can satisfy DecisionContext, or that the model routing
// strings in config.ts are even valid. Without this the first person to find out
// is the audience.
const hasKey = Boolean(process.env.OPENAI_API_KEY);

const COVERAGE: RoutingCoverage = ["stripe", "adyen", "mercado_pago"].map((providerId) => ({
  providerId,
  country: "BR",
  paymentMethod: "CARD",
}));

const rows = brCardGrid();

const dataSourceDeps = {
  source: {
    getWindowRollups: async () => rows,
    getHistory: async () => rows,
  },
  declineSource: {
    getWindowDeclines: async () => [],
    getHistory: async () => [],
  },
  loadMerchants: async () => DIAGNOSE_MERCHANTS,
  loadCoverage: async () => COVERAGE,
  loadDeclineCatalog: async () => DECLINE_CATALOG,
};

function investigationRequest() {
  const signal = confirmedDrop(BR_ROOT);
  return {
    schemaVersion: "1" as const,
    runId: "9f1d0a3e-4c7b-4a1e-9d2f-8b6c5e4d3a21",
    source: "detector_orchestrator" as const,
    trigger: signal,
    context: {
      merchantId: "BR_STORE_01",
      detectedAt: signal.windowBucket,
      rootDimensions: { merchantId: "BR_STORE_01", country: "BR" as const },
      similarIncidents: [],
    },
  };
}

describe.skipIf(!hasKey)("agent end-to-end against a real model", () => {
  it(
    "investigates the provider incident and returns a schema-valid diagnosis",
    { timeout: 180_000 },
    async () => {
      const config = loadAgentConfig();
      const request = investigationRequest();
      const auditStore = new InMemoryInvestigationAuditStore(request.runId, "agent");

      const result = await runInvestigation({
        request,
        config,
        dataSource: createDeterministicInvestigationDataSource(dataSourceDeps),
        auditStore,
      });

      if (result.outcome === "FAILED") {
        throw new Error(
          `Investigator failed against the real model (${config.investigatorModel}): ` +
            `${result.failureCode} — ${result.message}`,
        );
      }

      // The wiring claim: Mastra returned something the frozen contract accepts.
      expect(() => AgentDiagnosis.parse(result.diagnosis)).not.toThrow();
      expect(result.toolCallsUsed).toBeGreaterThan(0);
      expect(result.toolCallsUsed).toBeLessThanOrEqual(config.maxToolCalls);

      // The model had to produce a DecisionContext for every call it made.
      const trail = await auditStore.getTrail();
      expect(trail.steps.length).toBe(result.toolCallsUsed);
      for (const step of trail.steps) {
        expect(step.decisionTag).toBeTruthy();
        expect(step.decisionSummary).toBeTruthy();
        expect(step.stepNo).toBeGreaterThan(0);
      }
      // Steps are numbered once per run, so the audit trail is orderable.
      expect(trail.steps.map((step) => step.stepNo)).toEqual(
        trail.steps.map((_, index) => index + 1),
      );
    },
  );

  it(
    "narrates a closed evidence object without inventing a number",
    { timeout: 180_000 },
    async () => {
      const config = loadAgentConfig();
      const signal = confirmedDrop(BR_ROOT);
      const diagnoses = runDiagnosis({
        signals: [signal],
        windowBucket: BUCKET,
        rollups: rows,
        declines: [],
        declineHistory: [],
        merchants: DIAGNOSE_MERCHANTS,
        coverage: COVERAGE,
        catalog: DECLINE_CATALOG,
      });
      const diagnosis = diagnoses[0];
      if (!diagnosis) throw new Error("Expected the deterministic diagnosis to produce a candidate");

      const evidence = buildEvidence({ diagnosis, rows, diagnosisSource: "beam_search" });
      const recommendation = matchRecommendation(diagnosis);

      const narrative = await renderNarratives(config, { evidence, recommendation });

      expect(() => NarrativeOutput.parse(narrative)).not.toThrow();
      expect(narrative.operations.length).toBeGreaterThan(0);
      expect(narrative.executive.length).toBeGreaterThan(0);

      // rules.md §3 boundary #2, proven against a real model rather than a mock:
      // every number the narrator printed has to exist in the evidence object.
      // renderNarratives enforces this and degrades to the deterministic
      // template if the model breaks it, so reaching here at all means the
      // boundary held on both outputs.
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
    },
  );
});
