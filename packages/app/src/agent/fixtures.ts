import {
  type AgentRunResultV0,
  type DiagnosisResultV0,
  type InvestigationRequestV0,
  type NarrativeOutputV0,
  type ProvisionalEvidenceObjectV0,
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
  request: InvestigationRequestV0;
  evidence: ProvisionalEvidenceObjectV0;
  investigatorDiagnosis: DiagnosisResultV0;
  narratorOutput: NarrativeOutputV0;
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

export function conversionSliceKey(input: QueryConversionSliceInput): string {
  return stableScenarioKey(input);
}

export function conversionHistoryKey(input: QueryConversionHistoryInput): string {
  return stableScenarioKey(input);
}

export function declineMixKey(input: QueryDeclineMixInput): string {
  return stableScenarioKey(input);
}

export function residualTestKey(input: RunResidualTestInput): string {
  return stableScenarioKey(input);
}

export function onsetScanKey(input: ScanIncidentOnsetInput): string {
  return stableScenarioKey(input);
}

export function impactEstimateKey(input: EstimateIncidentImpactInput): string {
  return stableScenarioKey(input);
}

const request: InvestigationRequestV0 = {
  schemaVersion: "0",
  source: "mock",
  incident: {
    incidentId: "62f4aa31-a6d6-4b60-bf31-95037bb6b5f2",
    fingerprint: "merchant-1|adyen|BR|CARD|NA|issuer_timeout",
    merchantId: "merchant-1",
    dimensions: {
      merchantId: "merchant-1",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "NA",
    },
    dominantDecline: "issuer_timeout",
    detectedAt: "2026-08-30T14:06:00.000Z",
    startedAt: "2026-08-30T14:03:00.000Z",
    startedAtExact: true,
    baselineRate: 0.92,
    currentRate: 0.51,
    ciLow: 0.47,
    ciHigh: 0.55,
    ciLevel: 0.95,
  },
  trigger: {
    dimensions: {
      merchantId: "merchant-1",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "NA",
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
  similarIncidents: [
    {
      incidentId: "0db2f1b2-c643-4a6d-bbfb-18bf4c7daafe",
      fingerprint: "merchant-1|adyen|BR|CARD|NA|issuer_timeout",
      rootCauseDimension: "provider",
      dominantDecline: "issuer_timeout",
      summary: "Previous provider-side incident with similar decline mix.",
    },
  ],
};

const diagnosis: DiagnosisResultV0 = {
  status: "CONCLUSIVE",
  rootCause: {
    dimension: "provider",
    value: "adyen",
    declineFamily: "network",
    explanation: "Residual evidence isolates the provider slice while issuer echoes are suppressed.",
  },
  summary: "Provider degradation in BR card traffic explains the conversion drop.",
  supportingStepNos: [1, 2, 3, 4, 5, 6],
};

const evidence: ProvisionalEvidenceObjectV0 = {
  schemaVersion: "0",
  request,
  diagnosis,
  onset: {
    startedAt: "2026-08-30T14:03:00.000Z",
    startedAtExact: true,
    evidenceBuckets: [
      "2026-08-30T14:03:00.000Z",
      "2026-08-30T14:04:00.000Z",
      "2026-08-30T14:05:00.000Z",
    ],
  },
  impact: {
    lostApprovals: 173,
    costUsdMinor: 481200,
    costUsdPerMin: 160400,
    priorityScore: 88.2,
    costLocal: { BRL: 2500000 },
  },
  recommendation: {
    owner: "payments-ops",
    action: "Escalate Adyen BR card degradation through the human support channel.",
    humanApprovalRequired: true,
  },
  repetitions: {
    fingerprint: request.incident.fingerprint,
    count: 1,
    priorIncidentIds: ["0db2f1b2-c643-4a6d-bbfb-18bf4c7daafe"],
  },
  audit: {
    runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
    actor: "agent",
    steps: [],
  },
};

const narratorOutput: NarrativeOutputV0 = {
  operations:
    "Provider-level degradation on Adyen BR CARD traffic started at 2026-08-30T14:03:00.000Z and is costing 481200 USD minor units with 173 lost approvals.",
  executive:
    "The incident is isolated to provider Adyen on BR card traffic, with 481200 USD minor units at risk and human approval required for remediation.",
};

export const providerIncidentScenario: MockScenario = {
  request,
  evidence,
  investigatorDiagnosis: diagnosis,
  narratorOutput,
  toolResults: {
    queryConversionSlice: {
      [conversionSliceKey({
        dimensions: {
          merchantId: "merchant-1",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "CARD",
          issuerId: "NA",
        },
        windowBucket: "2026-08-30T14:06:00.000Z",
      })]: {
        dimensions: {
          merchantId: "merchant-1",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "CARD",
          issuerId: "NA",
        },
        windowBucket: "2026-08-30T14:06:00.000Z",
        attempts: 420,
        approved: 214,
        conversionRate: 0.51,
        expectedConversion: 0.92,
        deltaPp: 41,
      },
    },
    queryConversionHistory: {
      [conversionHistoryKey({
        dimensions: {
          merchantId: "merchant-1",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "CARD",
          issuerId: "NA",
        },
        fromBucket: "2026-08-30T14:03:00.000Z",
        toBucket: "2026-08-30T14:06:00.000Z",
      })]: {
        dimensions: {
          merchantId: "merchant-1",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "CARD",
          issuerId: "NA",
        },
        buckets: [
          { bucket: "2026-08-30T14:03:00.000Z", attempts: 140, approved: 72, conversionRate: 0.5143 },
          { bucket: "2026-08-30T14:04:00.000Z", attempts: 138, approved: 70, conversionRate: 0.5072 },
          { bucket: "2026-08-30T14:05:00.000Z", attempts: 142, approved: 72, conversionRate: 0.507 },
        ],
      },
    },
    queryDeclineMix: {
      [declineMixKey({
        dimensions: {
          merchantId: "merchant-1",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "CARD",
          issuerId: "NA",
        },
        windowBucket: "2026-08-30T14:06:00.000Z",
      })]: {
        windowBucket: "2026-08-30T14:06:00.000Z",
        dominantDecline: "issuer_timeout",
        families: [
          { declineCode: "issuer_timeout", family: "network", count: 118, share: 0.57 },
          { declineCode: "do_not_honor", family: "issuer", count: 54, share: 0.26 },
        ],
      },
    },
    runResidualTest: {
      [residualTestKey({
        candidateDimension: "provider",
        candidateValue: "adyen",
        comparisonDimensions: {
          merchantId: "merchant-1",
          country: "BR",
          paymentMethod: "CARD",
        },
      })]: {
        candidateDimension: "provider",
        candidateValue: "adyen",
        verdict: "ROOT_CAUSE",
        residualDeltaPp: 38.5,
        suppressedEchoes: [
          { dimension: "issuer", value: "itau" },
          { dimension: "issuer", value: "bradesco" },
        ],
      },
    },
    scanIncidentOnset: {
      [onsetScanKey({
        dimensions: {
          merchantId: "merchant-1",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "CARD",
          issuerId: "NA",
        },
        detectedAt: "2026-08-30T14:06:00.000Z",
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
        dimensions: {
          merchantId: "merchant-1",
          providerId: "adyen",
          country: "BR",
          paymentMethod: "CARD",
          issuerId: "NA",
        },
        startedAt: "2026-08-30T14:03:00.000Z",
        detectedAt: "2026-08-30T14:06:00.000Z",
      })]: {
        lostApprovals: 173,
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
  audit: ProvisionalEvidenceObjectV0["audit"],
): AgentRunResultV0 {
  const mergedEvidence: ProvisionalEvidenceObjectV0 = {
    ...defaultMockScenario.evidence,
    diagnosis: defaultMockScenario.investigatorDiagnosis,
    audit,
  };

  return {
    outcome: "COMPLETED",
    runId,
    diagnosis: defaultMockScenario.investigatorDiagnosis,
    evidence: mergedEvidence,
    toolCallsUsed: audit.steps.length,
    startedAt: audit.steps[0]?.createdAt ?? defaultMockScenario.request.incident.detectedAt,
    completedAt: audit.steps.at(-1)?.completedAt ?? defaultMockScenario.request.incident.detectedAt,
  };
}
