import { createTool } from "@mastra/core/tools";
import {
  DecisionContext,
  InvestigationToolName,
  refineInvestigationDimensions,
  type DecisionContext as DecisionContextType,
  type RootCauseDimension,
} from "@control-tower/contracts";
import { z } from "zod";
import { aggregate, aggregateByBucket, matchesFilter } from "../detect/aggregate.js";
import { MIN_VOLUME, ONSET_LOOKBACK_MIN } from "../detect/constants.js";
import { crossSectionalExpected, temporalExpected } from "../detect/expected.js";
import type { MerchantConfig, RollupRow, RoutingCoverage, SliceFilter } from "../detect/types.js";
import { evaluate } from "../detect/wilson.js";
import { cellKey } from "../diagnose/beam-search.js";
import { DECLINE_CURRENT_LOOKBACK_MIN, DECLINE_HISTORY_LOOKBACK_MIN } from "../diagnose/constants.js";
import { estimateImpact } from "../diagnose/cost.js";
import { declineMixShift } from "../diagnose/decline-mix.js";
import { peel } from "../diagnose/peeling.js";
import { residualDeficit } from "../diagnose/residual.js";
import type { DeclineCode, DeclineRollupRow } from "../diagnose/types.js";
import type { DeclineSource, RollupSource } from "../db/queries.js";
import type { InvestigationAuditStore } from "./audit.js";
import {
  conversionHistoryKey,
  conversionSliceKey,
  declineMixKey,
  impactEstimateKey,
  onsetScanKey,
  residualTestKey,
} from "./fixtures.js";

const rootCauseDimensionToSliceDimension: Record<
  Exclude<RootCauseDimension, "merchant" | "decline_code">,
  keyof SliceFilter
> = {
  provider: "providerId",
  country: "country",
  payment_method: "paymentMethod",
  issuer: "issuerId",
};

export const investigationDimensionsSchema = z
  .object({
    // An investigation is always scoped to one merchant; the rest of the cell
    // is what the agent narrows down. The routing rule itself is imported, not
    // restated (rules.md §1).
    merchantId: z.string().min(1),
    providerId: z.string().min(1).optional(),
    country: z.enum(["AR", "MX", "BR"]).optional(),
    paymentMethod: z.enum(["CARD", "PIX"]).optional(),
    issuerId: z.string().min(1).optional(),
  })
  .superRefine(refineInvestigationDimensions);

const toolDecisionContextSchema = DecisionContext;

export const queryConversionSliceInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
  decisionContext: toolDecisionContextSchema,
});
export type QueryConversionSliceInput = z.infer<typeof queryConversionSliceInputSchema>;

export const queryConversionSliceResultSchema = z.object({
  dimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
  attempts: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  conversionRate: z.number().min(0).max(1).nullable(),
  expectedConversion: z.number().min(0).max(1),
  expectedSource: z.enum(["cross_sectional", "temporal", "absolute"]),
  deltaPp: z.number().nonnegative(),
  ciLow: z.number().min(0).max(1),
  ciHigh: z.number().min(0).max(1),
  ciLevel: z.literal(0.95),
  state: z.enum(["MATERIAL_DROP", "HEALTHY", "MONITORING", "INSUFFICIENT_EVIDENCE"]),
});
export type QueryConversionSliceResult = z.infer<typeof queryConversionSliceResultSchema>;

export const queryConversionHistoryInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  fromBucket: z.string().datetime({ offset: true }),
  toBucket: z.string().datetime({ offset: true }),
  decisionContext: toolDecisionContextSchema,
});
export type QueryConversionHistoryInput = z.infer<typeof queryConversionHistoryInputSchema>;

export const queryConversionHistoryResultSchema = z.object({
  dimensions: investigationDimensionsSchema,
  fromBucket: z.string().datetime({ offset: true }),
  toBucket: z.string().datetime({ offset: true }),
  buckets: z.array(
    z.object({
      bucket: z.string().datetime({ offset: true }),
      attempts: z.number().int().nonnegative(),
      approved: z.number().int().nonnegative(),
      conversionRate: z.number().min(0).max(1).nullable(),
    }),
  ),
});
export type QueryConversionHistoryResult = z.infer<typeof queryConversionHistoryResultSchema>;

export const queryDeclineMixInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
  decisionContext: toolDecisionContextSchema,
});
export type QueryDeclineMixInput = z.infer<typeof queryDeclineMixInputSchema>;

export const queryDeclineMixResultSchema = z.object({
  dimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
  windowMinutes: z.number().int().positive(),
  totalDeclines: z.number().int().nonnegative(),
  referenceSource: z.enum(["catalog", "temporal"]),
  dominantDecline: z.string().min(1).nullable(),
  shifts: z.array(
    z.object({
      declineCode: z.string().min(1),
      family: z.string().min(1),
      diagnostic: z.boolean(),
      count: z.number().int().nonnegative(),
      observedShare: z.number().min(0).max(1),
      referenceShare: z.number().min(0).max(1),
      deltaPp: z.number(),
    }),
  ),
});
export type QueryDeclineMixResult = z.infer<typeof queryDeclineMixResultSchema>;

export const runResidualTestInputSchema = z.object({
  candidateDimension: z.enum(["merchant", "provider", "country", "payment_method", "issuer"]),
  candidateValue: z.string().min(1),
  rootDimensions: investigationDimensionsSchema,
  windowBucket: z.string().datetime({ offset: true }),
  decisionContext: toolDecisionContextSchema,
});
export type RunResidualTestInput = z.infer<typeof runResidualTestInputSchema>;

export const runResidualTestResultSchema = z.object({
  rootDimensions: investigationDimensionsSchema,
  candidateDimensions: investigationDimensionsSchema,
  verdict: z.enum(["ROOT_CAUSE", "ECHO", "INSUFFICIENT_EVIDENCE"]),
  explainedDeficit: z.number(),
  residualDeltaPp: z.number(),
  suppressedEchoes: z.array(
    z.object({
      dimensions: investigationDimensionsSchema,
      observedRate: z.number().min(0).max(1),
      residualRate: z.number().min(0).max(1).nullable(),
    }),
  ),
});
export type RunResidualTestResult = z.infer<typeof runResidualTestResultSchema>;

export const scanIncidentOnsetInputSchema = z.object({
  dimensions: investigationDimensionsSchema,
  detectedAt: z.string().datetime({ offset: true }),
  expectedConversion: z.number().min(0).max(1),
  deltaPp: z.number().nonnegative(),
  decisionContext: toolDecisionContextSchema,
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
  expectedConversion: z.number().min(0).max(1),
  decisionContext: toolDecisionContextSchema,
});
export type EstimateIncidentImpactInput = z.infer<typeof estimateIncidentImpactInputSchema>;

export const estimateIncidentImpactResultSchema = z.object({
  durationMin: z.number().int().nonnegative(),
  lostApprovals: z.number().int().nonnegative(),
  avgTicketUsdMinor: z.number().int().nonnegative(),
  costUsdMinor: z.number().int().nonnegative(),
  costUsdPerMin: z.number().int().nonnegative(),
  priorityScore: z.number().nonnegative(),
  costLocal: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().nonnegative()),
});
export type EstimateIncidentImpactResult = z.infer<typeof estimateIncidentImpactResultSchema>;

export interface InvestigationDataSource {
  queryConversionSlice(input: Omit<QueryConversionSliceInput, "decisionContext">): Promise<QueryConversionSliceResult>;
  queryConversionHistory(
    input: Omit<QueryConversionHistoryInput, "decisionContext">,
  ): Promise<QueryConversionHistoryResult>;
  queryDeclineMix(input: Omit<QueryDeclineMixInput, "decisionContext">): Promise<QueryDeclineMixResult>;
  runResidualTest(input: Omit<RunResidualTestInput, "decisionContext">): Promise<RunResidualTestResult>;
  scanIncidentOnset(input: Omit<ScanIncidentOnsetInput, "decisionContext">): Promise<ScanIncidentOnsetResult>;
  estimateIncidentImpact(
    input: Omit<EstimateIncidentImpactInput, "decisionContext">,
  ): Promise<EstimateIncidentImpactResult>;
}

export interface DeterministicInvestigationDataSourceDeps {
  source: RollupSource;
  declineSource: DeclineSource;
  loadMerchants: () => Promise<MerchantConfig[]>;
  loadCoverage: () => Promise<RoutingCoverage>;
  loadDeclineCatalog: () => Promise<DeclineCode[]>;
}

export interface ToolsetOptions {
  runId: string;
  maxToolCalls: number;
  auditStore: InvestigationAuditStore;
  dataSource: InvestigationDataSource;
  now?: () => Date;
}

type ToolInputWithDecision<T> = T & { decisionContext: DecisionContextType };

export class StepBudgetExceededError extends Error {
  constructor(readonly maxToolCalls: number) {
    super(`Agent exceeded the ${maxToolCalls} tool-call budget`);
    this.name = "StepBudgetExceededError";
  }
}

function shift(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function toSliceFilter(dimensions: z.infer<typeof investigationDimensionsSchema>): SliceFilter {
  return Object.fromEntries(
    Object.entries(dimensions).filter(([, value]) => value !== undefined),
  ) as SliceFilter;
}

function buildToolCallId(runId: string, stepNo: number, toolName: string): string {
  return `${runId}:${stepNo}:${toolName}`;
}

function requireMerchant(merchants: MerchantConfig[], merchantId: string): MerchantConfig {
  const merchant = merchants.find((entry) => entry.merchantId === merchantId);
  if (!merchant) {
    throw new Error(`Unknown merchant ${merchantId}`);
  }
  return merchant;
}

function isPixIssuerConflict(dimensions: SliceFilter): boolean {
  return dimensions.paymentMethod === "PIX" && dimensions.issuerId !== undefined && dimensions.issuerId !== "NA";
}

function parentOf(dimensions: SliceFilter): { parent: SliceFilter; splitDimension: keyof SliceFilter } | null {
  if (dimensions.issuerId !== undefined) {
    const { issuerId: _issuerId, ...parent } = dimensions;
    return { parent, splitDimension: "issuerId" };
  }
  if (dimensions.paymentMethod !== undefined) {
    const { paymentMethod: _paymentMethod, ...parent } = dimensions;
    return { parent, splitDimension: "paymentMethod" };
  }
  if (dimensions.providerId !== undefined) {
    const { providerId: _providerId, ...parent } = dimensions;
    return { parent, splitDimension: "providerId" };
  }
  return null;
}

async function computeExpectation(
  source: RollupSource,
  merchants: MerchantConfig[],
  dimensions: SliceFilter,
  windowBucket: string,
): Promise<{ expectedConversion: number; expectedSource: "cross_sectional" | "temporal" | "absolute"; deltaPp: number }> {
  if (!dimensions.merchantId) {
    throw new Error("Investigation dimensions must include merchantId");
  }

  const merchant = requireMerchant(merchants, dimensions.merchantId);
  const deltaPp = merchant.minMaterialDropPp;
  const rows = await source.getWindowRollups(windowBucket);

  const split = parentOf(dimensions);
  if (split) {
    const childValue = dimensions[split.splitDimension];
    if (typeof childValue === "string") {
      const expected = crossSectionalExpected(
        rows,
        split.parent,
        split.splitDimension as "providerId" | "paymentMethod" | "issuerId",
        childValue,
      );
      if (expected !== null) {
        return { expectedConversion: expected, expectedSource: "cross_sectional", deltaPp };
      }
    }
  }

  const fromBucket = shift(windowBucket, -120);
  const history = await source.getHistory(fromBucket, windowBucket);
  const temporal = temporalExpected(history, dimensions, fromBucket, windowBucket);
  if (temporal !== null) {
    return { expectedConversion: temporal, expectedSource: "temporal", deltaPp };
  }

  return {
    expectedConversion: merchant.expectedConversion,
    expectedSource: "absolute",
    deltaPp,
  };
}

export function createDeterministicInvestigationDataSource(
  deps: DeterministicInvestigationDataSourceDeps,
): InvestigationDataSource {
  return {
    async queryConversionSlice(input) {
      const dimensions = toSliceFilter(input.dimensions);
      if (isPixIssuerConflict(dimensions)) {
        throw new Error("PIX slices must not carry an issuer other than NA");
      }
      const [rows, merchants] = await Promise.all([
        deps.source.getWindowRollups(input.windowBucket),
        deps.loadMerchants(),
      ]);
      const agg = aggregate(rows, { filter: dimensions });
      const expectation = await computeExpectation(deps.source, merchants, dimensions, input.windowBucket);
      const evaluation = evaluate(
        agg.approved,
        agg.attempts,
        expectation.expectedConversion,
        expectation.deltaPp,
        MIN_VOLUME,
      );

      return queryConversionSliceResultSchema.parse({
        dimensions: input.dimensions,
        windowBucket: input.windowBucket,
        attempts: agg.attempts,
        approved: agg.approved,
        conversionRate: agg.rate,
        expectedConversion: expectation.expectedConversion,
        expectedSource: expectation.expectedSource,
        deltaPp: expectation.deltaPp,
        ciLow: evaluation.ci.low,
        ciHigh: evaluation.ci.high,
        ciLevel: 0.95,
        state: evaluation.state,
      });
    },

    async queryConversionHistory(input) {
      const rows = await deps.source.getHistory(input.fromBucket, input.toBucket);
      return queryConversionHistoryResultSchema.parse({
        dimensions: input.dimensions,
        fromBucket: input.fromBucket,
        toBucket: input.toBucket,
        buckets: aggregateByBucket(rows, { filter: toSliceFilter(input.dimensions) }).map((bucket) => ({
          bucket: bucket.bucket,
          attempts: bucket.attempts,
          approved: bucket.approved,
          conversionRate: bucket.rate,
        })),
      });
    },

    async queryDeclineMix(input) {
      const currentFrom = shift(input.windowBucket, -(DECLINE_CURRENT_LOOKBACK_MIN - 1));
      const historyFrom = shift(currentFrom, -DECLINE_HISTORY_LOOKBACK_MIN);
      const [catalog, declines, history] = await Promise.all([
        deps.loadDeclineCatalog(),
        deps.declineSource.getHistory(currentFrom, shift(input.windowBucket, 1)),
        deps.declineSource.getHistory(historyFrom, currentFrom),
      ]);
      const mix = declineMixShift(
        declines,
        toSliceFilter(input.dimensions),
        input.windowBucket,
        catalog,
        history,
      );

      return queryDeclineMixResultSchema.parse({
        dimensions: input.dimensions,
        windowBucket: input.windowBucket,
        windowMinutes: mix.windowUsed,
        totalDeclines: mix.totalDeclines,
        referenceSource: mix.referenceSource,
        dominantDecline: mix.dominantCode,
        shifts: mix.shifts.map((shift) => ({
          declineCode: shift.code,
          family: shift.family,
          diagnostic: shift.diagnostic,
          count: shift.count,
          observedShare: shift.observedShare,
          referenceShare: shift.referenceShare,
          deltaPp: shift.deltaPp,
        })),
      });
    },

    async runResidualTest(input) {
      const root = toSliceFilter(input.rootDimensions);
      const dimensionKey =
        input.candidateDimension === "merchant"
          ? "merchantId"
          : rootCauseDimensionToSliceDimension[input.candidateDimension];
      const candidate = { ...root, [dimensionKey]: input.candidateValue } as SliceFilter;
      const [rows, merchants, coverage] = await Promise.all([
        deps.source.getWindowRollups(input.windowBucket),
        deps.loadMerchants(),
        deps.loadCoverage(),
      ]);

      if (!root.merchantId) {
        throw new Error("Residual tests require merchantId on rootDimensions");
      }
      const merchant = requireMerchant(merchants, root.merchantId);
      const rootResidual = residualDeficit(rows, root, merchant.expectedConversion, merchant.minMaterialDropPp);
      if (rootResidual.attempts < MIN_VOLUME) {
        return runResidualTestResultSchema.parse({
          rootDimensions: input.rootDimensions,
          candidateDimensions: candidate,
          verdict: "INSUFFICIENT_EVIDENCE",
          explainedDeficit: 0,
          residualDeltaPp: 0,
          suppressedEchoes: [],
        });
      }

      const peels = peel(rows, root, merchant.expectedConversion, merchant.minMaterialDropPp, coverage);
      const matched = peels.find((entry) => cellKey(entry.causal.cell) === cellKey(candidate));
      const residual = residualDeficit(rows, root, merchant.expectedConversion, merchant.minMaterialDropPp, [candidate]);
      const rootRate = rootResidual.rate ?? 0;
      const residualRate = residual.rate ?? rootRate;

      return runResidualTestResultSchema.parse({
        rootDimensions: input.rootDimensions,
        candidateDimensions: candidate,
        verdict:
          rootResidual.state !== "MATERIAL_DROP"
            ? "INSUFFICIENT_EVIDENCE"
            : matched
              ? "ROOT_CAUSE"
              : "ECHO",
        explainedDeficit: matched?.causal.explainedDeficit ?? 0,
        residualDeltaPp: (residualRate - rootRate) * 100,
        suppressedEchoes: (matched?.suppressedEchoes ?? []).map((echo) => ({
          dimensions: echo.cell,
          observedRate: echo.observedRate,
          residualRate: echo.residualRate,
        })),
      });
    },

    async scanIncidentOnset(input) {
      const fromBucket = shift(input.detectedAt, -ONSET_LOOKBACK_MIN);
      const rows = await deps.source.getHistory(fromBucket, shift(input.detectedAt, 1));
      const filteredBuckets = aggregateByBucket(rows, { filter: toSliceFilter(input.dimensions) });
      let startedAt = input.detectedAt;
      let startedAtExact = false;
      const evidenceBuckets: string[] = [];
      const limit = input.expectedConversion - input.deltaPp / 100;

      for (let index = filteredBuckets.length - 1; index >= 0; index -= 1) {
        const bucket = filteredBuckets[index]!;
        if (bucket.attempts >= MIN_VOLUME && bucket.rate !== null && bucket.rate >= limit) {
          break;
        }
        startedAt = bucket.bucket;
        evidenceBuckets.unshift(bucket.bucket);
        if (bucket.attempts >= MIN_VOLUME) {
          startedAtExact = true;
        }
      }

      return scanIncidentOnsetResultSchema.parse({
        startedAt,
        startedAtExact,
        evidenceBuckets: evidenceBuckets.length > 0 ? evidenceBuckets : [input.detectedAt],
      });
    },

    async estimateIncidentImpact(input) {
      const rows = await deps.source.getHistory(input.startedAt, shift(input.detectedAt, 1));
      const impact = estimateImpact(
        rows,
        toSliceFilter(input.dimensions),
        input.expectedConversion,
        input.startedAt,
        input.detectedAt,
      );

      return estimateIncidentImpactResultSchema.parse({
        durationMin: impact.durationMin,
        lostApprovals: impact.lostApprovals,
        avgTicketUsdMinor: Math.round(impact.avgTicketUsdMinor),
        costUsdMinor: Math.round(impact.costUsdMinor),
        costUsdPerMin: Math.round(impact.costUsdPerMin),
        priorityScore: impact.priorityScore,
        costLocal: Object.fromEntries(
          Object.entries(impact.costLocal).map(([currency, value]) => [currency, Math.round(value)]),
        ),
      });
    },
  };
}

async function validateDecisionReferences(
  auditStore: InvestigationAuditStore,
  stepNo: number,
  decisionContext: DecisionContextType,
): Promise<void> {
  const trail = await auditStore.getTrail();
  const completedSteps = new Map(
    trail.steps
      .filter((step) => step.status === "completed")
      .map((step) => [step.stepNo, step]),
  );
  for (const ref of decisionContext.basedOnStepNos) {
    if (ref >= stepNo) {
      throw new Error(`decisionContext references future step ${ref}`);
    }
    if (!completedSteps.has(ref)) {
      throw new Error(`decisionContext references unavailable step ${ref}`);
    }
  }
}

async function recordCompletedStep(
  auditStore: InvestigationAuditStore,
  stepNo: number,
  runId: string,
  toolName: z.infer<typeof InvestigationToolName>,
  toolArgs: Record<string, unknown>,
  toolResult: Record<string, unknown>,
  decisionContext: DecisionContextType,
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
    decisionTag: decisionContext.tag,
    decisionSummary: decisionContext.summary,
    hypothesis: decisionContext.hypothesis,
    evidenceStepNos: decisionContext.basedOnStepNos,
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
  decisionContext: DecisionContextType,
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
    decisionTag: decisionContext.tag,
    decisionSummary: decisionContext.summary,
    hypothesis: decisionContext.hypothesis,
    evidenceStepNos: decisionContext.basedOnStepNos,
    createdAt,
    completedAt,
  });
}

function stripDecisionContext<T extends { decisionContext: DecisionContextType }>(
  input: T,
): [Omit<T, "decisionContext">, DecisionContextType] {
  const { decisionContext, ...rest } = input;
  return [rest, decisionContext];
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
      if (!match) throw new Error("No mock conversion slice registered for input");
      return match;
    },
    async queryConversionHistory(input) {
      const match = scenarioResults.queryConversionHistory[conversionHistoryKey(input)];
      if (!match) throw new Error("No mock conversion history registered for input");
      return match;
    },
    async queryDeclineMix(input) {
      const match = scenarioResults.queryDeclineMix[declineMixKey(input)];
      if (!match) throw new Error("No mock decline mix registered for input");
      return match;
    },
    async runResidualTest(input) {
      const match = scenarioResults.runResidualTest[residualTestKey(input)];
      if (!match) throw new Error("No mock residual test registered for input");
      return match;
    },
    async scanIncidentOnset(input) {
      const match = scenarioResults.scanIncidentOnset[onsetScanKey(input)];
      if (!match) throw new Error("No mock onset scan registered for input");
      return match;
    },
    async estimateIncidentImpact(input) {
      const match = scenarioResults.estimateIncidentImpact[impactEstimateKey(input)];
      if (!match) throw new Error("No mock impact estimate registered for input");
      return match;
    },
  };
}

// One counter per run, shared by every tool. Owning it per tool would make the
// budget `maxToolCalls * tool count`, make cross-tool `basedOnStepNos` unresolvable
// (every second tool would restart at 1 and its references read as "future"), and
// collide on investigation_steps' (run_id, step_no) primary key.
type StepCounter = { value: number };

function createToolExecutor<TInput extends { decisionContext: DecisionContextType }, TResult extends Record<string, unknown>>(
  options: ToolsetOptions,
  counter: StepCounter,
  toolName: z.infer<typeof InvestigationToolName>,
  execute: (input: Omit<TInput, "decisionContext">) => Promise<TResult>,
) {
  const now = options.now ?? (() => new Date());

  return async (input: TInput): Promise<TResult> => {
    counter.value += 1;
    const stepNo = counter.value;
    if (stepNo > options.maxToolCalls) {
      throw new StepBudgetExceededError(options.maxToolCalls);
    }

    const [toolArgs, decisionContext] = stripDecisionContext(input);
    await validateDecisionReferences(options.auditStore, stepNo, decisionContext);
    const createdAt = now().toISOString();

    try {
      const result = await execute(toolArgs);
      const completedAt = now().toISOString();
      await recordCompletedStep(
        options.auditStore,
        stepNo,
        options.runId,
        toolName,
        toolArgs as Record<string, unknown>,
        result,
        decisionContext,
        createdAt,
        completedAt,
      );
      return result;
    } catch (error) {
      const completedAt = now().toISOString();
      await recordFailedStep(
        options.auditStore,
        stepNo,
        options.runId,
        toolName,
        toolArgs as Record<string, unknown>,
        decisionContext,
        error,
        createdAt,
        completedAt,
      );
      throw error;
    }
  };
}

export function createInvestigationToolset(options: ToolsetOptions) {
  const counter: StepCounter = { value: 0 };
  const executeSlice = createToolExecutor<QueryConversionSliceInput, QueryConversionSliceResult>(
    options,
    counter,
    "query_conversion_slice",
    (input) => options.dataSource.queryConversionSlice(input),
  );
  const executeHistory = createToolExecutor<QueryConversionHistoryInput, QueryConversionHistoryResult>(
    options,
    counter,
    "query_conversion_history",
    (input) => options.dataSource.queryConversionHistory(input),
  );
  const executeDeclineMix = createToolExecutor<QueryDeclineMixInput, QueryDeclineMixResult>(
    options,
    counter,
    "query_decline_mix",
    (input) => options.dataSource.queryDeclineMix(input),
  );
  const executeResidual = createToolExecutor<RunResidualTestInput, RunResidualTestResult>(
    options,
    counter,
    "run_residual_test",
    (input) => options.dataSource.runResidualTest(input),
  );
  const executeOnset = createToolExecutor<ScanIncidentOnsetInput, ScanIncidentOnsetResult>(
    options,
    counter,
    "scan_incident_onset",
    (input) => options.dataSource.scanIncidentOnset(input),
  );
  const executeImpact = createToolExecutor<EstimateIncidentImpactInput, EstimateIncidentImpactResult>(
    options,
    counter,
    "estimate_incident_impact",
    (input) => options.dataSource.estimateIncidentImpact(input),
  );

  return {
    query_conversion_slice: createTool({
      id: "query_conversion_slice",
      description: "Returns aggregate conversion metrics, Wilson interval and state for one allowed rollup slice.",
      inputSchema: queryConversionSliceInputSchema,
      outputSchema: queryConversionSliceResultSchema,
      execute: (context: QueryConversionSliceInput) => executeSlice(context),
    }),
    query_conversion_history: createTool({
      id: "query_conversion_history",
      description: "Returns aggregate conversion history over an allowed bucket range.",
      inputSchema: queryConversionHistoryInputSchema,
      outputSchema: queryConversionHistoryResultSchema,
      execute: (context: QueryConversionHistoryInput) => executeHistory(context),
    }),
    query_decline_mix: createTool({
      id: "query_decline_mix",
      description: "Returns decline mix shifts, dominant decline and reference source for an allowed slice.",
      inputSchema: queryDeclineMixInputSchema,
      outputSchema: queryDeclineMixResultSchema,
      execute: (context: QueryDeclineMixInput) => executeDeclineMix(context),
    }),
    run_residual_test: createTool({
      id: "run_residual_test",
      description: "Runs the deterministic residual test to separate one candidate cell from its echoes.",
      inputSchema: runResidualTestInputSchema,
      outputSchema: runResidualTestResultSchema,
      execute: (context: RunResidualTestInput) => executeResidual(context),
    }),
    scan_incident_onset: createTool({
      id: "scan_incident_onset",
      description: "Finds the incident onset from historical rollup buckets and returns supporting buckets.",
      inputSchema: scanIncidentOnsetInputSchema,
      outputSchema: scanIncidentOnsetResultSchema,
      execute: (context: ScanIncidentOnsetInput) => executeOnset(context),
    }),
    estimate_incident_impact: createTool({
      id: "estimate_incident_impact",
      description: "Returns deterministic incident cost and priority estimates.",
      inputSchema: estimateIncidentImpactInputSchema,
      outputSchema: estimateIncidentImpactResultSchema,
      execute: (context: EstimateIncidentImpactInput) => executeImpact(context),
    }),
  };
}
