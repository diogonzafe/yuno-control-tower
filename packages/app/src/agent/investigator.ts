import { Agent } from "@mastra/core/agent";
import { ZodError } from "zod";
import {
  AgentRunResultV0,
  DiagnosisResultV0,
  ProvisionalEvidenceObjectV0,
  type AgentRunResultV0 as AgentRunResultV0Type,
  type DiagnosisResultV0 as DiagnosisResultV0Type,
  type InvestigationRequestV0,
} from "@control-tower/contracts";
import type { EvidenceProvider } from "./evidence-provider.js";
import type { InvestigationAuditStore } from "./audit.js";
import type { AgentConfig } from "./config.js";
import { InMemoryInvestigationAuditStore } from "./audit.js";
import type { InvestigationDataSource } from "./tools.js";
import { StepBudgetExceededError, createInvestigationToolset } from "./tools.js";

export interface InvestigatorAgentLike {
  generate(
    prompt: string,
    options: Record<string, unknown>,
  ): Promise<{ object?: unknown }>;
}

export interface RunInvestigationOptions {
  request: InvestigationRequestV0;
  runId: string;
  config: AgentConfig;
  dataSource: InvestigationDataSource;
  evidenceProvider: EvidenceProvider;
  agent?: InvestigatorAgentLike;
  auditStore?: InvestigationAuditStore;
  now?: () => Date;
}

const REQUIRED_CONCLUSIVE_TOOLS = new Set([
  "run_residual_test",
  "scan_incident_onset",
  "estimate_incident_impact",
]);

export function buildInvestigationPrompt(request: InvestigationRequestV0): string {
  return [
    "Investigate the payment conversion incident using only the provided tools.",
    "Never invent numbers, never infer raw transactions, and only return CONCLUSIVE when the audit includes residual, onset, and impact evidence.",
    `Incident fingerprint: ${request.incident.fingerprint}`,
    `Merchant: ${request.incident.merchantId}`,
    `Detected at: ${request.incident.detectedAt}`,
    `Observed conversion: ${request.trigger.observedRate}`,
    `Expected conversion: ${request.trigger.expectedRate}`,
  ].join("\n");
}

export function createInvestigatorAgent(
  config: AgentConfig,
  tools: ReturnType<typeof createInvestigationToolset>,
): Agent {
  return new Agent({
    id: "investigator-agent",
    name: "Investigator Agent",
    instructions:
      "You investigate payment conversion incidents. Use only the available tools, stay within the tool budget, and return a structured diagnosis.",
    model: config.investigatorModel,
    tools,
  });
}

export function validateConclusiveDiagnosis(
  diagnosis: DiagnosisResultV0Type,
  audit: Awaited<ReturnType<InvestigationAuditStore["getTrail"]>>,
): void {
  if (diagnosis.status !== "CONCLUSIVE") {
    return;
  }

  const byStep = new Map(audit.steps.map((step) => [step.stepNo, step]));
  for (const stepNo of diagnosis.supportingStepNos) {
    if (!byStep.has(stepNo)) {
      throw new Error(`Diagnosis references missing supporting step ${stepNo}`);
    }
  }

  const completedToolNames = new Set(
    audit.steps
      .filter((step) => step.status === "completed")
      .map((step) => step.toolName),
  );

  for (const requiredTool of REQUIRED_CONCLUSIVE_TOOLS as Set<
    "run_residual_test" | "scan_incident_onset" | "estimate_incident_impact"
  >) {
    if (!completedToolNames.has(requiredTool)) {
      throw new Error(`Conclusive diagnosis is missing required evidence from ${requiredTool}`);
    }
  }
}

function classifyFailure(error: unknown): { failureCode: "TIMEOUT" | "STEP_BUDGET_EXHAUSTED" | "MODEL_ERROR" | "INVALID_OUTPUT"; message: string } {
  if (error instanceof StepBudgetExceededError) {
    return { failureCode: "STEP_BUDGET_EXHAUSTED", message: error.message };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { failureCode: "TIMEOUT", message: error.message };
  }
  if (error instanceof ZodError) {
    return { failureCode: "INVALID_OUTPUT", message: error.message };
  }
  if (error instanceof Error && error.message.includes("structured")) {
    return { failureCode: "INVALID_OUTPUT", message: error.message };
  }
  if (error instanceof Error && error.message.includes("supporting step")) {
    return { failureCode: "INVALID_OUTPUT", message: error.message };
  }
  if (error instanceof Error && error.message.includes("required evidence")) {
    return { failureCode: "INVALID_OUTPUT", message: error.message };
  }
  return {
    failureCode: "MODEL_ERROR",
    message: error instanceof Error ? error.message : "Unknown model error",
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Agent timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runInvestigation(
  options: RunInvestigationOptions,
): Promise<AgentRunResultV0Type> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const auditStore =
    options.auditStore ?? new InMemoryInvestigationAuditStore(options.runId, "agent");
  const tools = createInvestigationToolset({
    runId: options.runId,
    maxToolCalls: options.config.maxToolCalls,
    auditStore,
    dataSource: options.dataSource,
    now,
  });
  const agent =
    options.agent ?? createInvestigatorAgent(options.config, tools);

  try {
    const response = await withTimeout(
      agent.generate(buildInvestigationPrompt(options.request), {
        structuredOutput: {
          schema: DiagnosisResultV0,
          errorStrategy: "strict",
          jsonPromptInjection: true,
        },
        modelSettings: {
          maxRetries: 0,
        },
        toolCallConcurrency: 1,
      }),
      options.config.timeoutMs,
    );
    const diagnosis = DiagnosisResultV0.parse(response.object);
    const audit = await auditStore.getTrail();
    validateConclusiveDiagnosis(diagnosis, audit);
    const baseEvidence = await options.evidenceProvider.getEvidence(options.request);
    const evidence = ProvisionalEvidenceObjectV0.parse({
      ...baseEvidence,
      request: options.request,
      diagnosis,
      audit,
    });
    return AgentRunResultV0.parse({
      outcome: "COMPLETED",
      runId: options.runId,
      diagnosis,
      evidence,
      toolCallsUsed: audit.steps.length,
      startedAt,
      completedAt: now().toISOString(),
    });
  } catch (error) {
    const failure = classifyFailure(error);
    return AgentRunResultV0.parse({
      outcome: "FAILED",
      runId: options.runId,
      failureCode: failure.failureCode,
      message: failure.message,
      startedAt,
      completedAt: now().toISOString(),
    });
  }
}
