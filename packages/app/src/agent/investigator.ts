import { Agent } from "@mastra/core/agent";
import {
  AgentDiagnosis,
  AgentRunResult,
  type AgentDiagnosis as AgentDiagnosisType,
  type AgentRunResult as AgentRunResultType,
  type InvestigationRequestV1,
} from "@control-tower/contracts";
import { ZodError } from "zod";
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
  request: InvestigationRequestV1;
  config: AgentConfig;
  dataSource: InvestigationDataSource;
  agent?: InvestigatorAgentLike;
  auditStore?: InvestigationAuditStore;
  now?: () => Date;
}

const REQUIRED_CONCLUSIVE_TOOLS = new Set([
  "run_residual_test",
  "scan_incident_onset",
  "estimate_incident_impact",
]);

export function buildInvestigationPrompt(request: InvestigationRequestV1): string {
  return [
    "Investigate the payment conversion incident using only the provided tools.",
    "Never invent numbers, never infer raw transactions, and never emit <thinking>.",
    "Each tool call must include a decisionContext with tag, summary, optional hypothesis, and basedOnStepNos.",
    "The decision summary must be public, short, evidence-based, and under 500 characters.",
    "Return CONCLUSIVE only when the audit trail includes completed residual, onset, and impact evidence.",
    `Run id: ${request.runId}`,
    `Merchant: ${request.context.merchantId}`,
    `Detected at: ${request.context.detectedAt}`,
    `Observed conversion: ${request.trigger.observedRate}`,
    `Expected conversion: ${request.trigger.expectedRate}`,
    `Root dimensions: ${JSON.stringify(request.context.rootDimensions)}`,
    `Similar incidents: ${JSON.stringify(request.context.similarIncidents)}`,
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
      "You investigate payment conversion incidents. Use only the available tools, stay within the tool budget, always include a public decisionContext for each tool call, and return a structured diagnosis without hidden reasoning.",
    model: config.investigatorModel,
    tools,
  });
}

export function validateConclusiveDiagnosis(
  diagnosis: AgentDiagnosisType,
  audit: Awaited<ReturnType<InvestigationAuditStore["getTrail"]>>,
): void {
  const byStep = new Map(audit.steps.map((step) => [step.stepNo, step]));
  for (const stepNo of diagnosis.supportingStepNos) {
    const step = byStep.get(stepNo);
    if (!step) {
      throw new Error(`Diagnosis references missing supporting step ${stepNo}`);
    }
    if (step.status !== "completed") {
      throw new Error(`Diagnosis references incomplete supporting step ${stepNo}`);
    }
  }

  if (diagnosis.status !== "CONCLUSIVE") {
    return;
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

function classifyFailure(
  error: unknown,
): {
  failureCode: "TIMEOUT" | "STEP_BUDGET_EXHAUSTED" | "MODEL_ERROR" | "INVALID_OUTPUT" | "MISSING_REQUIRED_EVIDENCE";
  message: string;
} {
  if (error instanceof StepBudgetExceededError) {
    return { failureCode: "STEP_BUDGET_EXHAUSTED", message: error.message };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { failureCode: "TIMEOUT", message: error.message };
  }
  if (error instanceof Error && error.message.includes("required evidence")) {
    return { failureCode: "MISSING_REQUIRED_EVIDENCE", message: error.message };
  }
  if (error instanceof Error && error.message.includes("supporting step")) {
    return { failureCode: "INVALID_OUTPUT", message: error.message };
  }
  if (error instanceof ZodError) {
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
): Promise<AgentRunResultType> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const auditStore =
    options.auditStore ?? new InMemoryInvestigationAuditStore(options.request.runId, "agent");
  const tools = createInvestigationToolset({
    runId: options.request.runId,
    maxToolCalls: options.config.maxToolCalls,
    auditStore,
    dataSource: options.dataSource,
    now,
  });
  const agent = options.agent ?? createInvestigatorAgent(options.config, tools);

  try {
    const response = await withTimeout(
      agent.generate(buildInvestigationPrompt(options.request), {
        structuredOutput: {
          schema: AgentDiagnosis,
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
    const diagnosis = AgentDiagnosis.parse(response.object);
    const audit = await auditStore.getTrail();
    validateConclusiveDiagnosis(diagnosis, audit);
    return AgentRunResult.parse({
      outcome: "COMPLETED",
      runId: options.request.runId,
      diagnosis,
      audit,
      toolCallsUsed: audit.steps.length,
      startedAt,
      completedAt: now().toISOString(),
    });
  } catch (error) {
    const failure = classifyFailure(error);
    const audit = await auditStore.getTrail();
    return AgentRunResult.parse({
      outcome: "FAILED",
      runId: options.request.runId,
      failureCode: failure.failureCode,
      message: failure.message,
      audit,
      startedAt,
      completedAt: now().toISOString(),
    });
  }
}
