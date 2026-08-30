import {
  type AgentDiagnosis,
  type ConfirmedDrop,
  type EvidenceObject,
  type InvestigationRequestV1,
  type NarrativeOutput,
} from "@control-tower/contracts";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./config.js";
import { runInvestigation } from "./investigator.js";
import { type InvestigationRunRepository } from "./persistence.js";
import { matchRecommendation } from "./playbooks.js";
import { renderNarratives } from "./narrator.js";
import {
  createDeterministicInvestigationDataSource,
  type DeterministicInvestigationDataSourceDeps,
} from "./tools.js";
import { DECLINE_CURRENT_LOOKBACK_MIN, DECLINE_HISTORY_LOOKBACK_MIN } from "../diagnose/constants.js";
import { buildEvidence } from "../diagnose/evidence.js";
import { runDiagnosis, type Diagnosis } from "../diagnose/run.js";

type CoordinatorDeps = DeterministicInvestigationDataSourceDeps & {
  repository: InvestigationRunRepository;
  config: AgentConfig;
  onEvidence?: (evidence: EvidenceObject) => void;
  onNarrative?: (payload: { incidentId: string; narrative: NarrativeOutput }) => void;
};

function shift(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function buildRequest(signal: ConfirmedDrop): InvestigationRequestV1 {
  if (!signal.dimensions.merchantId || !signal.dimensions.country) {
    throw new Error("ConfirmedDrop must include merchantId and country for orchestration");
  }
  return {
    schemaVersion: "1",
    runId: randomUUID(),
    source: "detector_orchestrator",
    trigger: signal,
    context: {
      merchantId: signal.dimensions.merchantId,
      detectedAt: signal.windowBucket,
      rootDimensions: {
        merchantId: signal.dimensions.merchantId,
        country: signal.dimensions.country,
      },
      similarIncidents: [],
    },
  };
}

async function loadDiagnoses(
  deps: DeterministicInvestigationDataSourceDeps,
  signal: ConfirmedDrop,
): Promise<Diagnosis[]> {
  const currentFrom = shift(signal.windowBucket, -(DECLINE_CURRENT_LOOKBACK_MIN - 1));
  const referenceFrom = shift(currentFrom, -DECLINE_HISTORY_LOOKBACK_MIN);
  const [windowRows, history, declines, declineHistory, merchants, coverage, catalog] = await Promise.all([
    deps.source.getWindowRollups(signal.windowBucket),
    deps.source.getHistory(shift(signal.windowBucket, -120), shift(signal.windowBucket, 1)),
    deps.declineSource.getHistory(currentFrom, shift(signal.windowBucket, 1)),
    deps.declineSource.getHistory(referenceFrom, currentFrom),
    deps.loadMerchants(),
    deps.loadCoverage(),
    deps.loadDeclineCatalog(),
  ]);

  return runDiagnosis({
    signals: [signal],
    windowBucket: signal.windowBucket,
    rollups: history.filter((row) => row.bucket < signal.windowBucket).concat(windowRows),
    declines,
    declineHistory,
    merchants,
    coverage,
    catalog,
  });
}

function sameCell(left: Record<string, string | undefined>, right: Record<string, string | undefined>): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return keys.every((key) => left[key] === right[key]);
}

export async function materializeAgentDiagnosis(
  deps: DeterministicInvestigationDataSourceDeps,
  request: InvestigationRequestV1,
  diagnosis: AgentDiagnosis,
): Promise<Diagnosis> {
  const diagnoses = await loadDiagnoses(deps, request.trigger);
  if (diagnoses.length === 0) {
    throw new Error("Deterministic diagnosis produced no candidates");
  }

  if (diagnosis.status === "INCONCLUSIVE") {
    return diagnoses[0]!;
  }

  const matched = diagnoses.find((candidate) => sameCell(candidate.cell, diagnosis.selectedCell));
  if (!matched) {
    throw new Error("Agent selected a cell that deterministic diagnosis could not validate");
  }
  return matched;
}

function fallbackStatusFromFailure(
  failureCode: string,
): "failed" | "timed_out" | "exhausted" {
  if (failureCode === "TIMEOUT") return "timed_out";
  if (failureCode === "STEP_BUDGET_EXHAUSTED") return "exhausted";
  return "failed";
}

export function createAgentCoordinator(deps: CoordinatorDeps) {
  const dataSource = createDeterministicInvestigationDataSource(deps);

  async function persistOutcome(request: InvestigationRequestV1, diagnosis: Diagnosis, runIds: string[]) {
    const evidence = buildEvidence({
      diagnosis,
      rows: await deps.source.getHistory(shift(request.trigger.windowBucket, -120), shift(request.trigger.windowBucket, 1)),
      diagnosisSource: runIds.length > 1 ? "beam_search" : "agent",
    });
    const recommendation = matchRecommendation(diagnosis);
    const narrative = await renderNarratives(deps.config, { evidence, recommendation });
    const incidentId = await deps.repository.upsertIncidentFromEvidence({
      evidence,
      narrativeOps: narrative.operations,
      narrativeExec: narrative.executive,
      playbookId: recommendation?.playbookId ?? null,
    });

    for (const runId of runIds) {
      await deps.repository.linkRunToIncident(runId, incidentId);
    }

    deps.onEvidence?.(evidence);
    deps.onNarrative?.({ incidentId, narrative });

    return { incidentId, evidence, narrative };
  }

  async function executeFallback(request: InvestigationRequestV1, previousRunIds: string[]) {
    const runId = randomUUID();
    const now = new Date().toISOString();
    const fallbackRequest: InvestigationRequestV1 = { ...request, runId };
    await deps.repository.createRun({
      runId,
      actor: "fallback",
      modelId: null,
      promptVersion: "agentic-v1",
      requestSnapshot: fallbackRequest,
      startedAt: now,
    });
    const diagnosis = (await loadDiagnoses(deps, request.trigger))[0];
    if (!diagnosis) {
      throw new Error("Fallback diagnosis produced no candidates");
    }
    await persistOutcome(request, diagnosis, previousRunIds.concat(runId));
    await deps.repository.completeRun({
      runId,
      completedAt: new Date().toISOString(),
      conclusionTag: diagnosis.confidence === "CONFIRMED" ? "STOP_CONCLUSIVE" : "STOP_INCONCLUSIVE",
      conclusionSummary:
        diagnosis.confidence === "CONFIRMED"
          ? "Beam search completed with deterministic causal evidence."
          : "Beam search completed without enough evidence for a conclusive cause.",
      supportingStepNos: [],
    });
  }

  return {
    async handleSignal(signal: ConfirmedDrop): Promise<void> {
      const request = buildRequest(signal);
      await deps.repository.createRun({
        runId: request.runId,
        actor: "agent",
        modelId: deps.config.investigatorModel,
        promptVersion: "agentic-v1",
        requestSnapshot: request,
        startedAt: new Date().toISOString(),
      });

      try {
        const result = await runInvestigation({
          request,
          config: deps.config,
          dataSource,
          auditStore: deps.repository.createAuditStore(request.runId, "agent"),
        });

        if (result.outcome === "FAILED") {
          await deps.repository.failRun({
            runId: request.runId,
            completedAt: result.completedAt,
            status: fallbackStatusFromFailure(result.failureCode),
            failureCode: result.failureCode,
          });
          await executeFallback(request, [request.runId]);
          return;
        }

        const materialized = await materializeAgentDiagnosis(deps, request, result.diagnosis);
        const persisted = await persistOutcome(request, materialized, [request.runId]);
        await deps.repository.completeRun({
          runId: request.runId,
          completedAt: result.completedAt,
          conclusionTag: result.diagnosis.conclusionTag,
          conclusionSummary: result.diagnosis.summary,
          supportingStepNos: result.diagnosis.supportingStepNos,
        });
        await deps.repository.linkRunToIncident(request.runId, persisted.incidentId);
      } catch {
        await executeFallback(request, [request.runId]);
      }
    },

    async recoverOrphanRuns(): Promise<void> {
      const orphanRuns = await deps.repository.listOrphanRuns();
      for (const orphan of orphanRuns) {
        await deps.repository.failRun({
          runId: orphan.runId,
          completedAt: new Date().toISOString(),
          status: "failed",
          failureCode: "MODEL_ERROR",
        });
        await executeFallback(orphan.requestSnapshot, [orphan.runId]);
      }
    },
  };
}
