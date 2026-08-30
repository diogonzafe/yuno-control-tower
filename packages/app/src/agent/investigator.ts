import { Agent } from "@mastra/core/agent";
import {
  AgentDiagnosisWire,
  AgentRunResult,
  narrowAgentDiagnosis,
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
  // Our own deadline (TimeoutError / AbortError from the AbortController) and
  // Mastra's native modelSettings.timeout (MastraTimeoutError) both land here.
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      error.name === "MastraTimeoutError" ||
      /\b(timed out|timeout|aborted)\b/i.test(error.message))
  ) {
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

// Race a deadline that also *aborts* the underlying work. Mastra honours
// `modelSettings.timeout` natively, but a hung socket or a provider SDK
// swallowing the signal used to leave `agent.generate` pending for tens of
// minutes (one recorded run ran 44 min) while the outer promise had already
// rejected — and that stuck promise kept run.ts's orchestrationTail queue
// blocked behind it. Firing the AbortController on the same timer cancels the
// request for real; `withDeadline` still rejects so classifyFailure sees TIMEOUT.
function withDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`Agent timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);

    start(controller.signal).then(
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
    const response = await withDeadline(
      (abortSignal) =>
        agent.generate(buildInvestigationPrompt(options.request), {
          structuredOutput: {
            // Flat, strict-mode-compatible shape (see AgentDiagnosisWire):
            // the discriminated AgentDiagnosis is a root-level anyOf, which
            // OpenAI Structured Outputs rejects, so `strict` never engaged and
            // the model free-formed the JSON (INVALID_OUTPUT). narrow() below
            // restores the real union.
            schema: AgentDiagnosisWire,
            errorStrategy: "strict",
            jsonPromptInjection: true,
          },
          modelSettings: {
            // One transient schema/API miss shouldn't sink the whole run.
            maxRetries: 2,
            // Native ceiling so a stuck step can't outlive the deadline.
            timeout: {
              totalMs: options.config.timeoutMs,
              stepMs: Math.min(options.config.timeoutMs, 30_000),
            },
          },
          toolCallConcurrency: 1,
          abortSignal,
        }),
      options.config.timeoutMs,
    );
    const diagnosis = narrowAgentDiagnosis(AgentDiagnosisWire.parse(response.object));
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
