import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { InvestigationToolName, ROOT_CAUSE_DIMENSIONS, validRoutingCombination } from "@control-tower/contracts";
import type { InvestigationAuditStore } from "./audit.js";
import {
  conversionHistoryKey,
  conversionSliceKey,
  declineMixKey,
  impactEstimateKey,
  onsetScanKey,
  residualTestKey,
} from "./fixtures.js";

export const investigationDimensionsSchema = z
  .object({
    merchantId: z.string().min(1),
    providerId: z.string().min(1).optional(),
    country: z.enum(["AR", "MX", "BR"]).optional(),
    paymentMethod: z.enum(["CARD", "PIX"]).optional(),
    issuerId: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
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
  });

export const queryConversionSliceInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
});
export type QueryConversionSliceInput = z.infer<typeof queryConversionSliceInputSchema>;

export const queryConversionSliceResultSchema = z.object({
  dimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
  attempts: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  conversionRate: z.number().min(0).max(1),
  expectedConversion: z.number().min(0).max(1),
  deltaPp: z.number().nonnegative(),
});
export type QueryConversionSliceResult = z.infer<typeof queryConversionSliceResultSchema>;

export const queryConversionHistoryInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  fromBucket: z.string().datetime({ offset: true }),
  toBucket: z.string().datetime({ offset: true }),
});
export type QueryConversionHistoryInput = z.infer<typeof queryConversionHistoryInputSchema>;

export const queryConversionHistoryResultSchema = z.object({
  dimensions: investigationDimensionsSchema,
  buckets: z.array(
    z.object({
      bucket: z.string().datetime({ offset: true }),
      attempts: z.number().int().nonnegative(),
      approved: z.number().int().nonnegative(),
      conversionRate: z.number().min(0).max(1),
    }),
  ),
});
export type QueryConversionHistoryResult = z.infer<typeof queryConversionHistoryResultSchema>;

export const queryDeclineMixInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
});
export type QueryDeclineMixInput = z.infer<typeof queryDeclineMixInputSchema>;

export const queryDeclineMixResultSchema = z.object({
  windowBucket: z.string().datetime({ offset: true }),
  dominantDecline: z.string().min(1).nullable(),
  families: z.array(
    z.object({
      declineCode: z.string().min(1),
      family: z.string().min(1),
      count: z.number().int().nonnegative(),
      share: z.number().min(0).max(1),
    }),
  ),
});
export type QueryDeclineMixResult = z.infer<typeof queryDeclineMixResultSchema>;

export const runResidualTestInputSchema = z.object({
  candidateDimension: z.enum(ROOT_CAUSE_DIMENSIONS),
  candidateValue: z.string().min(1),
  comparisonDimensions: investigationDimensionsSchema,
});
export type RunResidualTestInput = z.infer<typeof runResidualTestInputSchema>;

export const runResidualTestResultSchema = z.object({
  candidateDimension: z.enum(ROOT_CAUSE_DIMENSIONS),
  candidateValue: z.string().min(1),
  verdict: z.enum(["ROOT_CAUSE", "ECHO", "INSUFFICIENT_EVIDENCE"]),
  residualDeltaPp: z.number(),
  suppressedEchoes: z.array(
    z.object({
      dimension: z.enum(ROOT_CAUSE_DIMENSIONS),
      value: z.string().min(1),
    }),
  ),
});
export type RunResidualTestResult = z.infer<typeof runResidualTestResultSchema>;

export const scanIncidentOnsetInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  detectedAt: z.string().datetime({ offset: true }),
});
export type ScanIncidentOnsetInput = z.infer<typeof scanIncidentOnsetInputSchema>;

export const scanIncidentOnsetResultSchema = z.object({
  startedAt: z.string().datetime({ offset: true }),
  startedAtExact: z.boolean(),
  evidenceBuckets: z.array(z.string().datetime({ offset: true })).min(1),
});
export type ScanIncidentOnsetResult = z.infer<typeof scanIncidentOnsetResultSchema>;

export const estimateIncidentImpactInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  startedAt: z.string().datetime({ offset: true }),
  detectedAt: z.string().datetime({ offset: true }),
});
export type EstimateIncidentImpactInput = z.infer<typeof estimateIncidentImpactInputSchema>;

export const estimateIncidentImpactResultSchema = z.object({
  lostApprovals: z.number().int().nonnegative(),
  costUsdMinor: z.number().int().nonnegative(),
  costUsdPerMin: z.number().int().nonnegative(),
  priorityScore: z.number().nonnegative(),
  costLocal: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().nonnegative()),
});
export type EstimateIncidentImpactResult = z.infer<typeof estimateIncidentImpactResultSchema>;

export interface InvestigationDataSource {
  queryConversionSlice(input: QueryConversionSliceInput): Promise<QueryConversionSliceResult>;
  queryConversionHistory(input: QueryConversionHistoryInput): Promise<QueryConversionHistoryResult>;
  queryDeclineMix(input: QueryDeclineMixInput): Promise<QueryDeclineMixResult>;
  runResidualTest(input: RunResidualTestInput): Promise<RunResidualTestResult>;
  scanIncidentOnset(input: ScanIncidentOnsetInput): Promise<ScanIncidentOnsetResult>;
  estimateIncidentImpact(input: EstimateIncidentImpactInput): Promise<EstimateIncidentImpactResult>;
}

export interface ToolsetOptions {
  runId: string;
  maxToolCalls: number;
  auditStore: InvestigationAuditStore;
  dataSource: InvestigationDataSource;
  now?: () => Date;
}

export class StepBudgetExceededError extends Error {
  constructor(readonly maxToolCalls: number) {
    super(`Agent exceeded the ${maxToolCalls} tool-call budget`);
    this.name = "StepBudgetExceededError";
  }
}

function buildToolCallId(runId: string, stepNo: number, toolName: string): string {
  return `${runId}:${stepNo}:${toolName}`;
}

async function recordCompletedStep(
  auditStore: InvestigationAuditStore,
  stepNo: number,
  runId: string,
  toolName: z.infer<typeof InvestigationToolName>,
  toolArgs: Record<string, unknown>,
  toolResult: Record<string, unknown>,
  createdAt: string,
  completedAt: string,
): Promise<void> {
  await auditStore.recordStep({
    stepNo,
    toolCallId: buildToolCallId(runId, stepNo, toolName),
    toolName,
    toolArgs,
    toolResult,
    status: "completed",
    errorCode: null,
    decisionSummary: `${toolName} completed successfully`,
    createdAt,
    completedAt,
  });
}

async function recordFailedStep(
  auditStore: InvestigationAuditStore,
  stepNo: number,
  runId: string,
  toolName: z.infer<typeof InvestigationToolName>,
  toolArgs: Record<string, unknown>,
  error: unknown,
  createdAt: string,
  completedAt: string,
): Promise<void> {
  await auditStore.recordStep({
    stepNo,
    toolCallId: buildToolCallId(runId, stepNo, toolName),
    toolName,
    toolArgs,
    toolResult: null,
    status: "failed",
    errorCode: error instanceof Error ? error.name : "UnknownError",
    decisionSummary: error instanceof Error ? error.message : "tool execution failed",
    createdAt,
    completedAt,
  });
}

export function createMockInvestigationDataSource(
  scenarioResults: {
    queryConversionSlice: Record<string, QueryConversionSliceResult>;
    queryConversionHistory: Record<string, QueryConversionHistoryResult>;
    queryDeclineMix: Record<string, QueryDeclineMixResult>;
    runResidualTest: Record<string, RunResidualTestResult>;
    scanIncidentOnset: Record<string, ScanIncidentOnsetResult>;
    estimateIncidentImpact: Record<string, EstimateIncidentImpactResult>;
  },
): InvestigationDataSource {
  return {
    async queryConversionSlice(input) {
      const match = scenarioResults.queryConversionSlice[conversionSliceKey(input)];
      if (!match) {
        throw new Error("No mock conversion slice registered for input");
      }
      return match;
    },
    async queryConversionHistory(input) {
      const match = scenarioResults.queryConversionHistory[conversionHistoryKey(input)];
      if (!match) {
        throw new Error("No mock conversion history registered for input");
      }
      return match;
    },
    async queryDeclineMix(input) {
      const match = scenarioResults.queryDeclineMix[declineMixKey(input)];
      if (!match) {
        throw new Error("No mock decline mix registered for input");
      }
      return match;
    },
    async runResidualTest(input) {
      const match = scenarioResults.runResidualTest[residualTestKey(input)];
      if (!match) {
        throw new Error("No mock residual test registered for input");
      }
      return match;
    },
    async scanIncidentOnset(input) {
      const match = scenarioResults.scanIncidentOnset[onsetScanKey(input)];
      if (!match) {
        throw new Error("No mock onset scan registered for input");
      }
      return match;
    },
    async estimateIncidentImpact(input) {
      const match = scenarioResults.estimateIncidentImpact[impactEstimateKey(input)];
      if (!match) {
        throw new Error("No mock impact estimate registered for input");
      }
      return match;
    },
  };
}

export function createInvestigationToolset(options: ToolsetOptions) {
  let stepNo = 0;
  const now = options.now ?? (() => new Date());

  const nextStep = () => {
    stepNo += 1;
    if (stepNo > options.maxToolCalls) {
      throw new StepBudgetExceededError(options.maxToolCalls);
    }
    return stepNo;
  };

  return {
    query_conversion_slice: createTool({
      id: "query_conversion_slice",
      description: "Returns aggregate conversion metrics for a single allowed rollup slice.",
      inputSchema: queryConversionSliceInputSchema,
      outputSchema: queryConversionSliceResultSchema,
      execute: async (context: QueryConversionSliceInput) => {
        const currentStep = nextStep();
        const createdAt = now().toISOString();
        try {
          const result = await options.dataSource.queryConversionSlice(context);
          const completedAt = now().toISOString();
          await recordCompletedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "query_conversion_slice",
            context,
            result,
            createdAt,
            completedAt,
          );
          return result;
        } catch (error) {
          const completedAt = now().toISOString();
          await recordFailedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "query_conversion_slice",
            context,
            error,
            createdAt,
            completedAt,
          );
          throw error;
        }
      },
    }),
    query_conversion_history: createTool({
      id: "query_conversion_history",
      description: "Returns aggregate conversion history over an allowed bucket range.",
      inputSchema: queryConversionHistoryInputSchema,
      outputSchema: queryConversionHistoryResultSchema,
      execute: async (context: QueryConversionHistoryInput) => {
        const currentStep = nextStep();
        const createdAt = now().toISOString();
        try {
          const result = await options.dataSource.queryConversionHistory(context);
          const completedAt = now().toISOString();
          await recordCompletedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "query_conversion_history",
            context,
            result,
            createdAt,
            completedAt,
          );
          return result;
        } catch (error) {
          const completedAt = now().toISOString();
          await recordFailedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "query_conversion_history",
            context,
            error,
            createdAt,
            completedAt,
          );
          throw error;
        }
      },
    }),
    query_decline_mix: createTool({
      id: "query_decline_mix",
      description: "Returns decline-family composition for an allowed slice and bucket.",
      inputSchema: queryDeclineMixInputSchema,
      outputSchema: queryDeclineMixResultSchema,
      execute: async (context: QueryDeclineMixInput) => {
        const currentStep = nextStep();
        const createdAt = now().toISOString();
        try {
          const result = await options.dataSource.queryDeclineMix(context);
          const completedAt = now().toISOString();
          await recordCompletedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "query_decline_mix",
            context,
            result,
            createdAt,
            completedAt,
          );
          return result;
        } catch (error) {
          const completedAt = now().toISOString();
          await recordFailedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "query_decline_mix",
            context,
            error,
            createdAt,
            completedAt,
          );
          throw error;
        }
      },
    }),
    run_residual_test: createTool({
      id: "run_residual_test",
      description: "Runs a deterministic residual test to separate root causes from echoes.",
      inputSchema: runResidualTestInputSchema,
      outputSchema: runResidualTestResultSchema,
      execute: async (context: RunResidualTestInput) => {
        const currentStep = nextStep();
        const createdAt = now().toISOString();
        try {
          const result = await options.dataSource.runResidualTest(context);
          const completedAt = now().toISOString();
          await recordCompletedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "run_residual_test",
            context,
            result,
            createdAt,
            completedAt,
          );
          return result;
        } catch (error) {
          const completedAt = now().toISOString();
          await recordFailedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "run_residual_test",
            context,
            error,
            createdAt,
            completedAt,
          );
          throw error;
        }
      },
    }),
    scan_incident_onset: createTool({
      id: "scan_incident_onset",
      description: "Finds the incident onset using deterministic bucket scans.",
      inputSchema: scanIncidentOnsetInputSchema,
      outputSchema: scanIncidentOnsetResultSchema,
      execute: async (context: ScanIncidentOnsetInput) => {
        const currentStep = nextStep();
        const createdAt = now().toISOString();
        try {
          const result = await options.dataSource.scanIncidentOnset(context);
          const completedAt = now().toISOString();
          await recordCompletedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "scan_incident_onset",
            context,
            result,
            createdAt,
            completedAt,
          );
          return result;
        } catch (error) {
          const completedAt = now().toISOString();
          await recordFailedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "scan_incident_onset",
            context,
            error,
            createdAt,
            completedAt,
          );
          throw error;
        }
      },
    }),
    estimate_incident_impact: createTool({
      id: "estimate_incident_impact",
      description: "Returns deterministic impact and priority estimates for the incident.",
      inputSchema: estimateIncidentImpactInputSchema,
      outputSchema: estimateIncidentImpactResultSchema,
      execute: async (context: EstimateIncidentImpactInput) => {
        const currentStep = nextStep();
        const createdAt = now().toISOString();
        try {
          const result = await options.dataSource.estimateIncidentImpact(context);
          const completedAt = now().toISOString();
          await recordCompletedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "estimate_incident_impact",
            context,
            result,
            createdAt,
            completedAt,
          );
          return result;
        } catch (error) {
          const completedAt = now().toISOString();
          await recordFailedStep(
            options.auditStore,
            currentStep,
            options.runId,
            "estimate_incident_impact",
            context,
            error,
            createdAt,
            completedAt,
          );
          throw error;
        }
      },
    }),
  };
}
