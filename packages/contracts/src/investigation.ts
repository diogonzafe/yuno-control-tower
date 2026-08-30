import { z } from "zod";
import { COUNTRIES, PAYMENT_METHODS } from "./transaction.js";
import { ConfirmedDrop, Dimensions } from "./incident.js";

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

export const InvestigationRunFailureCode = z.enum([
  "TIMEOUT",
  "STEP_BUDGET_EXHAUSTED",
  "MODEL_ERROR",
  "INVALID_OUTPUT",
]);
export type InvestigationRunFailureCode = z.infer<typeof InvestigationRunFailureCode>;

export const InvestigationAuditStepV0 = z.object({
  stepNo: z.number().int().positive(),
  toolCallId: z.string().min(1),
  toolName: InvestigationToolName,
  toolArgs: z.record(z.string(), z.unknown()),
  toolResult: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["completed", "failed"]),
  errorCode: z.string().min(1).nullable(),
  decisionSummary: z.string().min(1).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
});
export type InvestigationAuditStepV0 = z.infer<typeof InvestigationAuditStepV0>;

export const InvestigationAuditTrailV0 = z.object({
  runId: z.string().uuid(),
  actor: z.enum(["agent", "fallback"]),
  steps: z.array(InvestigationAuditStepV0),
});
export type InvestigationAuditTrailV0 = z.infer<typeof InvestigationAuditTrailV0>;

export const SimilarIncidentV0 = z.object({
  incidentId: z.string().uuid(),
  fingerprint: z.string().min(1),
  rootCauseDimension: z.enum(ROOT_CAUSE_DIMENSIONS).nullable(),
  dominantDecline: z.string().min(1).nullable(),
  summary: z.string().min(1),
});
export type SimilarIncidentV0 = z.infer<typeof SimilarIncidentV0>;

export const InvestigationIncidentV0 = z.object({
  incidentId: z.string().uuid(),
  fingerprint: z.string().min(1),
  merchantId: z.string().min(1),
  dimensions: Dimensions,
  dominantDecline: z.string().min(1).nullable(),
  detectedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }),
  startedAtExact: z.boolean(),
  baselineRate: z.number().min(0).max(1),
  currentRate: z.number().min(0).max(1),
  ciLow: z.number().min(0).max(1),
  ciHigh: z.number().min(0).max(1),
  ciLevel: z.number().positive().max(1),
});
export type InvestigationIncidentV0 = z.infer<typeof InvestigationIncidentV0>;

export const InvestigationRequestV0 = z.object({
  schemaVersion: z.literal("0"),
  source: z.enum(["mock", "detector_orchestrator"]),
  incident: InvestigationIncidentV0,
  trigger: ConfirmedDrop,
  similarIncidents: z.array(SimilarIncidentV0),
}).superRefine((value, ctx) => {
  const incidentRoute = value.incident.dimensions;
  if (incidentRoute.country && incidentRoute.paymentMethod) {
    const result = validRoutingCombination.safeParse({
      country: incidentRoute.country,
      paymentMethod: incidentRoute.paymentMethod,
    });
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["incident", "dimensions", "paymentMethod"],
        message: result.error.issues[0]?.message ?? "invalid routing combination",
      });
    }
  }

  const triggerRoute = value.trigger.dimensions;
  if (triggerRoute.country && triggerRoute.paymentMethod) {
    const result = validRoutingCombination.safeParse({
      country: triggerRoute.country,
      paymentMethod: triggerRoute.paymentMethod,
    });
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "dimensions", "paymentMethod"],
        message: result.error.issues[0]?.message ?? "invalid routing combination",
      });
    }
  }
});
export type InvestigationRequestV0 = z.infer<typeof InvestigationRequestV0>;

export const RootCauseV0 = z.object({
  dimension: z.enum(ROOT_CAUSE_DIMENSIONS),
  value: z.string().min(1),
  declineFamily: z.string().min(1).nullable(),
  explanation: z.string().min(1),
});
export type RootCauseV0 = z.infer<typeof RootCauseV0>;

export const ConclusiveDiagnosisV0 = z.object({
  status: z.literal("CONCLUSIVE"),
  rootCause: RootCauseV0,
  summary: z.string().min(1),
  supportingStepNos: z.array(z.number().int().positive()).min(1),
});
export type ConclusiveDiagnosisV0 = z.infer<typeof ConclusiveDiagnosisV0>;

export const InconclusiveDiagnosisV0 = z.object({
  status: z.literal("INCONCLUSIVE"),
  reason: z.enum(["INSUFFICIENT_EVIDENCE", "NO_ROOT_CAUSE", "CONFLICTING_SIGNALS"]),
  summary: z.string().min(1),
  supportingStepNos: z.array(z.number().int().positive()),
});
export type InconclusiveDiagnosisV0 = z.infer<typeof InconclusiveDiagnosisV0>;

export const DiagnosisResultV0 = z.union([ConclusiveDiagnosisV0, InconclusiveDiagnosisV0]);
export type DiagnosisResultV0 = z.infer<typeof DiagnosisResultV0>;

export const IncidentOnsetV0 = z.object({
  startedAt: z.string().datetime({ offset: true }),
  startedAtExact: z.boolean(),
  evidenceBuckets: z.array(z.string().datetime({ offset: true })).min(1),
});
export type IncidentOnsetV0 = z.infer<typeof IncidentOnsetV0>;

export const IncidentImpactV0 = z.object({
  lostApprovals: z.number().int().nonnegative(),
  costUsdMinor: z.number().int().nonnegative(),
  costUsdPerMin: z.number().int().nonnegative(),
  priorityScore: z.number().nonnegative(),
  costLocal: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().nonnegative()),
});
export type IncidentImpactV0 = z.infer<typeof IncidentImpactV0>;

export const RecommendationV0 = z.object({
  owner: z.string().min(1),
  action: z.string().min(1),
  humanApprovalRequired: z.literal(true),
});
export type RecommendationV0 = z.infer<typeof RecommendationV0>;

export const RepetitionEvidenceV0 = z.object({
  fingerprint: z.string().min(1),
  count: z.number().int().nonnegative(),
  priorIncidentIds: z.array(z.string().uuid()),
});
export type RepetitionEvidenceV0 = z.infer<typeof RepetitionEvidenceV0>;

export const ProvisionalEvidenceObjectV0 = z.object({
  schemaVersion: z.literal("0"),
  request: InvestigationRequestV0,
  diagnosis: DiagnosisResultV0,
  onset: IncidentOnsetV0,
  impact: IncidentImpactV0,
  recommendation: RecommendationV0,
  repetitions: RepetitionEvidenceV0,
  audit: InvestigationAuditTrailV0,
});
export type ProvisionalEvidenceObjectV0 = z.infer<typeof ProvisionalEvidenceObjectV0>;

export const NarrativeOutputV0 = z.object({
  operations: z.string().min(1),
  executive: z.string().min(1),
});
export type NarrativeOutputV0 = z.infer<typeof NarrativeOutputV0>;

export const AgentRunCompletedV0 = z.object({
  outcome: z.literal("COMPLETED"),
  runId: z.string().uuid(),
  diagnosis: DiagnosisResultV0,
  evidence: ProvisionalEvidenceObjectV0,
  toolCallsUsed: z.number().int().nonnegative(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
});
export type AgentRunCompletedV0 = z.infer<typeof AgentRunCompletedV0>;

export const AgentRunFailedV0 = z.object({
  outcome: z.literal("FAILED"),
  runId: z.string().uuid(),
  failureCode: InvestigationRunFailureCode,
  message: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
});
export type AgentRunFailedV0 = z.infer<typeof AgentRunFailedV0>;

export const AgentRunResultV0 = z.union([AgentRunCompletedV0, AgentRunFailedV0]);
export type AgentRunResultV0 = z.infer<typeof AgentRunResultV0>;

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
