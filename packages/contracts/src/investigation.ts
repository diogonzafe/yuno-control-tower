import { z } from "zod";
import { COUNTRIES, PAYMENT_METHODS } from "./transaction.js";
import { ConfirmedDrop, Dimensions } from "./detection.js";

export const ROOT_CAUSE_DIMENSIONS = [
  "merchant",
  "provider",
  "country",
  "payment_method",
  "issuer",
  "decline_code",
] as const;
export type RootCauseDimension = (typeof ROOT_CAUSE_DIMENSIONS)[number];

export const InvestigationToolName = z.enum([
  "query_conversion_slice",
  "query_conversion_history",
  "query_decline_mix",
  "run_residual_test",
  "scan_incident_onset",
  "estimate_incident_impact",
]);
export type InvestigationToolName = z.infer<typeof InvestigationToolName>;

export const DecisionTag = z.enum([
  "HYPOTHESIS",
  "DRILL_DOWN",
  "COMPARE_HISTORY",
  "CHECK_DECLINE_MIX",
  "VALIDATE_RESIDUAL",
  "CONFIRM_ONSET",
  "ESTIMATE_IMPACT",
]);
export type DecisionTag = z.infer<typeof DecisionTag>;

export const ConclusionTag = z.enum(["STOP_CONCLUSIVE", "STOP_INCONCLUSIVE"]);
export type ConclusionTag = z.infer<typeof ConclusionTag>;

export const InvestigationRunFailureCode = z.enum([
  "TIMEOUT",
  "STEP_BUDGET_EXHAUSTED",
  "MODEL_ERROR",
  "INVALID_OUTPUT",
  "MISSING_REQUIRED_EVIDENCE",
]);
export type InvestigationRunFailureCode = z.infer<typeof InvestigationRunFailureCode>;

export const validRoutingCombination = z
  .object({
    country: z.enum(COUNTRIES),
    paymentMethod: z.enum(PAYMENT_METHODS),
  })
  .refine(({ country, paymentMethod }) => paymentMethod !== "PIX" || country === "BR", {
    message: "PIX is only valid when country is BR (DD5)",
    path: ["paymentMethod"],
  });
export type ValidRoutingCombination = z.infer<typeof validRoutingCombination>;

// The single definition of what makes a slice addressable: PIX only exists in
// BR, and a PIX slice never carries a real issuer. Exported so callers that need
// a stricter base (agent/tools.ts requires merchantId) reuse the rule instead of
// restating it — rules.md §1: two copies diverge on the first change.
export function refineInvestigationDimensions(
  value: { country?: string; paymentMethod?: string; issuerId?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.country && value.paymentMethod) {
    const route = validRoutingCombination.safeParse({
      country: value.country,
      paymentMethod: value.paymentMethod,
    });
    if (!route.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentMethod"],
        message: route.error.issues[0]?.message ?? "invalid routing combination",
      });
    }
  }

  if (value.paymentMethod === "PIX" && value.issuerId && value.issuerId !== "NA") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issuerId"],
      message: "PIX slices must not carry an issuer other than NA",
    });
  }
}

export const investigationDimensionsSchema = Dimensions.superRefine(refineInvestigationDimensions);

export const SimilarIncident = z.object({
  incidentId: z.string().uuid(),
  fingerprint: z.string().min(1),
  rootCauseDimension: z.enum(ROOT_CAUSE_DIMENSIONS).nullable(),
  dominantDecline: z.string().min(1).nullable(),
  summary: z.string().min(1),
});
export type SimilarIncident = z.infer<typeof SimilarIncident>;

export const InvestigationRequestV1 = z.object({
  schemaVersion: z.literal("1"),
  runId: z.string().uuid(),
  source: z.enum(["mock", "detector_orchestrator"]),
  trigger: ConfirmedDrop,
  context: z.object({
    merchantId: z.string().min(1),
    detectedAt: z.string().datetime({ offset: true }),
    rootDimensions: investigationDimensionsSchema,
    similarIncidents: z.array(SimilarIncident),
  }),
}).superRefine((value, ctx) => {
  const triggerRoute = investigationDimensionsSchema.safeParse(value.trigger.dimensions);
  if (!triggerRoute.success) {
    for (const issue of triggerRoute.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ["trigger", "dimensions", ...issue.path],
      });
    }
  }
});
export type InvestigationRequestV1 = z.infer<typeof InvestigationRequestV1>;

export const Hypothesis = z.object({
  dimension: z.enum(ROOT_CAUSE_DIMENSIONS),
  value: z.string().min(1),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const DecisionContext = z.object({
  tag: DecisionTag,
  summary: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !/<thinking>/i.test(value), "summary must not include <thinking>"),
  hypothesis: Hypothesis.nullable(),
  basedOnStepNos: z.array(z.number().int().positive()),
});
export type DecisionContext = z.infer<typeof DecisionContext>;

export const InvestigationAuditStep = z.object({
  stepNo: z.number().int().positive(),
  toolCallId: z.string().min(1),
  toolName: InvestigationToolName,
  toolArgs: z.record(z.string(), z.unknown()),
  toolResult: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["completed", "failed"]),
  errorCode: z.string().min(1).nullable(),
  decisionTag: DecisionTag,
  decisionSummary: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !/<thinking>/i.test(value), "decisionSummary must not include <thinking>"),
  hypothesis: Hypothesis.nullable(),
  evidenceStepNos: z.array(z.number().int().positive()),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
});
export type InvestigationAuditStep = z.infer<typeof InvestigationAuditStep>;

export const InvestigationAuditTrail = z.object({
  runId: z.string().uuid(),
  actor: z.enum(["agent", "fallback"]),
  steps: z.array(InvestigationAuditStep),
});
export type InvestigationAuditTrail = z.infer<typeof InvestigationAuditTrail>;

const agentDiagnosisBase = z.object({
  selectedCell: investigationDimensionsSchema,
  summary: z.string().min(1),
  supportingStepNos: z.array(z.number().int().positive()),
});

export const ConclusiveAgentDiagnosis = agentDiagnosisBase.extend({
  status: z.literal("CONCLUSIVE"),
  conclusionTag: z.literal("STOP_CONCLUSIVE"),
  causalDimension: z.enum(ROOT_CAUSE_DIMENSIONS),
  declineFamily: z.string().min(1).nullable(),
});
export type ConclusiveAgentDiagnosis = z.infer<typeof ConclusiveAgentDiagnosis>;

export const InconclusiveAgentDiagnosis = agentDiagnosisBase.extend({
  status: z.literal("INCONCLUSIVE"),
  conclusionTag: z.literal("STOP_INCONCLUSIVE"),
  causalDimension: z.null(),
  declineFamily: z.null(),
  reason: z.enum(["INSUFFICIENT_EVIDENCE", "NO_ROOT_CAUSE", "CONFLICTING_SIGNALS"]),
});
export type InconclusiveAgentDiagnosis = z.infer<typeof InconclusiveAgentDiagnosis>;

export const AgentDiagnosis = z.union([ConclusiveAgentDiagnosis, InconclusiveAgentDiagnosis]);
export type AgentDiagnosis = z.infer<typeof AgentDiagnosis>;

export const MatchedRecommendation = z.object({
  playbookId: z.string().min(1),
  owner: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  actions: z.array(z.string().min(1)).min(1),
  humanApprovalRequired: z.literal(true),
});
export type MatchedRecommendation = z.infer<typeof MatchedRecommendation>;

export const NarrativeOutput = z.object({
  operations: z.string().min(1),
  executive: z.string().min(1),
});
export type NarrativeOutput = z.infer<typeof NarrativeOutput>;

const runResultBase = z.object({
  runId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  audit: InvestigationAuditTrail,
});

export const AgentRunCompleted = runResultBase.extend({
  outcome: z.literal("COMPLETED"),
  diagnosis: AgentDiagnosis,
  toolCallsUsed: z.number().int().nonnegative(),
});
export type AgentRunCompleted = z.infer<typeof AgentRunCompleted>;

export const AgentRunFailed = runResultBase.extend({
  outcome: z.literal("FAILED"),
  failureCode: InvestigationRunFailureCode,
  message: z.string().min(1),
});
export type AgentRunFailed = z.infer<typeof AgentRunFailed>;

export const AgentRunResult = z.union([AgentRunCompleted, AgentRunFailed]);
export type AgentRunResult = z.infer<typeof AgentRunResult>;
