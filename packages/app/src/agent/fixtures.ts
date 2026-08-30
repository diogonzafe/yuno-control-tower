import type {
  AgentDiagnosis,
  AgentRunResult,
  InvestigationAuditTrail,
  InvestigationRequestV1,
  MatchedRecommendation,
  NarrativeOutput,
} from "@control-tower/contracts";
import type {
  EstimateIncidentImpactInput,
  EstimateIncidentImpactResult,
  QueryConversionHistoryInput,
  QueryConversionHistoryResult,
  QueryConversionSliceInput,
  QueryConversionSliceResult,
  QueryDeclineMixInput,
  QueryDeclineMixResult,
  RunResidualTestInput,
  RunResidualTestResult,
  ScanIncidentOnsetInput,
  ScanIncidentOnsetResult,
} from "./tools.js";

export interface MockScenario {
  request: InvestigationRequestV1;
  diagnosis: AgentDiagnosis;
  recommendation: MatchedRecommendation;
  narratorOutput: NarrativeOutput;
  toolResults: {
    queryConversionSlice: Record<string, QueryConversionSliceResult>;
    queryConversionHistory: Record<string, QueryConversionHistoryResult>;
    queryDeclineMix: Record<string, QueryDeclineMixResult>;
    runResidualTest: Record<string, RunResidualTestResult>;
    scanIncidentOnset: Record<string, ScanIncidentOnsetResult>;
    estimateIncidentImpact: Record<string, EstimateIncidentImpactResult>;
  };
}

export function stableScenarioKey(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map((item) => stableScenarioKey(item)).join(",")}]`;
  }

  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `"${key}":${stableScenarioKey(value)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(input);
}

export function conversionSliceKey(input: Omit<QueryConversionSliceInput, "decisionContext">): string {
  return stableScenarioKey(input);
}

export function conversionHistoryKey(input: Omit<QueryConversionHistoryInput, "decisionContext">): string {
  return stableScenarioKey(input);
}

export function declineMixKey(input: Omit<QueryDeclineMixInput, "decisionContext">): string {
  return stableScenarioKey(input);
}

export function residualTestKey(input: Omit<RunResidualTestInput, "decisionContext">): string {
  return stableScenarioKey(input);
}

export function onsetScanKey(input: Omit<ScanIncidentOnsetInput, "decisionContext">): string {
  return stableScenarioKey(input);
}

export function impactEstimateKey(input: Omit<EstimateIncidentImpactInput, "decisionContext">): string {
  return stableScenarioKey(input);
}

const rootDimensions = {
  merchantId: "merchant-1",
  country: "BR",
} as const;

const request: InvestigationRequestV1 = {
  schemaVersion: "1",
  runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
  source: "mock",
  trigger: {
    dimensions: {
      merchantId: "merchant-1",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    },
    windowBucket: "2026-08-30T14:06:00.000Z",
    observedRate: 0.51,
    expectedRate: 0.92,
    expectedSource: "cross_sectional",
    deltaPp: 41,
    ciLow: 0.47,
    ciHigh: 0.55,
    ciLevel: 0.95,
    attempts: 420,
    approved: 214,
    windowUsed: "1m",
    startedAt: "2026-08-30T14:03:00.000Z",
    startedAtExact: true,
    consecutiveWindows: 3,
  },
  context: {
    merchantId: "merchant-1",
    detectedAt: "2026-08-30T14:06:00.000Z",
    rootDimensions,
    similarIncidents: [
      {
        incidentId: "0db2f1b2-c643-4a6d-bbfb-18bf4c7daafe",
        fingerprint: "country=BR|merchantId=merchant-1|providerId=adyen#91",
        rootCauseDimension: "provider",
        dominantDecline: "91",
        summary: "Previous provider-side incident with similar decline mix.",
      },
    ],
  },
};

const selectedCell = {
  merchantId: "merchant-1",
  providerId: "adyen",
  country: "BR",
  paymentMethod: "CARD",
  issuerId: "itau",
} as const;

const diagnosis: AgentDiagnosis = {
  status: "CONCLUSIVE",
  conclusionTag: "STOP_CONCLUSIVE",
  selectedCell,
  causalDimension: "provider",
  declineFamily: "network",
  summary: "Provider degradation in BR card traffic explains the conversion drop.",
  supportingStepNos: [1, 2, 3],
};

const recommendation: MatchedRecommendation = {
  playbookId: "provider-default",
  owner: "provider-ops",
  title: "Provider degradation escalation",
  summary: "Escalate the provider owner and prepare a human-reviewed rerouting proposal.",
  actions: [
    "Open an escalation with the affected provider including the impacted slice and decline evidence.",
    "Prepare a rerouting proposal for human approval before changing traffic.",
  ],
  humanApprovalRequired: true,
};

const narratorOutput: NarrativeOutput = {
  operations:
    "Provider-level degradation on Adyen BR CARD traffic started at 2026-08-30T14:03:00.000Z and is costing 160400 USD minor units per minute.",
  executive:
    "Provider Adyen on BR card traffic is costing 160400 USD minor units per minute and needs human approval for action.",
};

export const providerIncidentScenario: MockScenario = {
  request,
  diagnosis,
  recommendation,
  narratorOutput,
  toolResults: {
    queryConversionSlice: {
      [conversionSliceKey({
        dimensions: selectedCell,
        windowBucket: request.trigger.windowBucket,
      })]: {
        dimensions: selectedCell,
        windowBucket: request.trigger.windowBucket,
        attempts: 420,
        approved: 214,
        conversionRate: 0.51,
        expectedConversion: 0.92,
        expectedSource: "cross_sectional",
        deltaPp: 41,
        ciLow: 0.47,
        ciHigh: 0.55,
        ciLevel: 0.95,
        state: "MATERIAL_DROP",
      },
    },
    queryConversionHistory: {
      [conversionHistoryKey({
        dimensions: selectedCell,
        fromBucket: "2026-08-30T14:03:00.000Z",
        toBucket: "2026-08-30T14:06:00.000Z",
      })]: {
        dimensions: selectedCell,
        fromBucket: "2026-08-30T14:03:00.000Z",
        toBucket: "2026-08-30T14:06:00.000Z",
        buckets: [
          { bucket: "2026-08-30T14:03:00.000Z", attempts: 140, approved: 72, conversionRate: 0.5143 },
          { bucket: "2026-08-30T14:04:00.000Z", attempts: 138, approved: 70, conversionRate: 0.5072 },
          { bucket: "2026-08-30T14:05:00.000Z", attempts: 142, approved: 72, conversionRate: 0.507 },
        ],
      },
    },
    queryDeclineMix: {
      [declineMixKey({
        dimensions: selectedCell,
        windowBucket: request.trigger.windowBucket,
      })]: {
        dimensions: selectedCell,
        windowBucket: request.trigger.windowBucket,
        windowMinutes: 5,
        totalDeclines: 207,
        referenceSource: "catalog",
        dominantDecline: "91",
        shifts: [
          {
            declineCode: "91",
            family: "network",
            diagnostic: true,
            count: 118,
            observedShare: 0.57,
            referenceShare: 0.02,
            deltaPp: 55,
          },
        ],
      },
    },
    runResidualTest: {
      [residualTestKey({
        candidateDimension: "provider",
        candidateValue: "adyen",
        rootDimensions,
        windowBucket: request.trigger.windowBucket,
      })]: {
        rootDimensions,
        candidateDimensions: {
          merchantId: "merchant-1",
          country: "BR",
          providerId: "adyen",
        },
        verdict: "ROOT_CAUSE",
        explainedDeficit: 38.5,
        residualDeltaPp: 38.5,
        suppressedEchoes: [
          {
            dimensions: {
              merchantId: "merchant-1",
              country: "BR",
              paymentMethod: "CARD",
            },
            observedRate: 0.51,
            residualRate: 0.92,
          },
        ],
      },
    },
    scanIncidentOnset: {
      [onsetScanKey({
        dimensions: selectedCell,
        detectedAt: request.context.detectedAt,
        expectedConversion: 0.92,
        deltaPp: 41,
      })]: {
        startedAt: "2026-08-30T14:03:00.000Z",
        startedAtExact: true,
        evidenceBuckets: [
          "2026-08-30T14:03:00.000Z",
          "2026-08-30T14:04:00.000Z",
          "2026-08-30T14:05:00.000Z",
        ],
      },
    },
    estimateIncidentImpact: {
      [impactEstimateKey({
        dimensions: selectedCell,
        startedAt: "2026-08-30T14:03:00.000Z",
        detectedAt: request.context.detectedAt,
        expectedConversion: 0.92,
      })]: {
        durationMin: 4,
        lostApprovals: 173,
        avgTicketUsdMinor: 2782,
        costUsdMinor: 481200,
        costUsdPerMin: 160400,
        priorityScore: 88.2,
        costLocal: { BRL: 2500000 },
      },
    },
  },
};

export const defaultMockScenario = providerIncidentScenario;

export function buildExpectedCompletedRun(
  runId: string,
  audit: InvestigationAuditTrail,
): AgentRunResult {
  return {
    outcome: "COMPLETED",
    runId,
    diagnosis: defaultMockScenario.diagnosis,
    audit,
    toolCallsUsed: audit.steps.length,
    startedAt: audit.steps[0]?.createdAt ?? defaultMockScenario.request.context.detectedAt,
    completedAt: audit.steps.at(-1)?.completedAt ?? defaultMockScenario.request.context.detectedAt,
  };
}
