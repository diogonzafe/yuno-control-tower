import { describe, expect, it } from "vitest";
import {
  AgentRunResultV0,
  DiagnosisResultV0,
  InvestigationRequestV0,
  NarrativeOutputV0,
  ProvisionalEvidenceObjectV0,
} from "./index.js";

const request = {
  schemaVersion: "0",
  source: "mock",
  incident: {
    incidentId: "62f4aa31-a6d6-4b60-bf31-95037bb6b5f2",
    fingerprint: "merchant-1|adyen|BR|CARD|itau|issuer_timeout",
    merchantId: "merchant-1",
    dimensions: {
      merchantId: "merchant-1",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
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
    dimensions: { merchantId: "merchant-1", providerId: "adyen", country: "BR" },
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
  similarIncidents: [],
} as const;

const diagnosis = {
  status: "CONCLUSIVE",
  rootCause: {
    dimension: "provider",
    value: "adyen",
    declineFamily: "network",
    explanation: "Provider-level conversion dropped while issuer residual stayed healthy.",
  },
  summary: "Provider degradation in BR card traffic explains the drop.",
  supportingStepNos: [1, 2, 3, 4],
} as const;

describe("investigation contracts", () => {
  it("accepts a well-formed investigation request", () => {
    expect(() => InvestigationRequestV0.parse(request)).not.toThrow();
  });

  it("rejects PIX outside BR in routing validation", () => {
    const result = InvestigationRequestV0.safeParse({
      ...request,
      incident: {
        ...request.incident,
        dimensions: {
          ...request.incident.dimensions,
          country: "MX",
          paymentMethod: "PIX",
        },
      },
      trigger: {
        ...request.trigger,
        dimensions: {
          ...request.trigger.dimensions,
          country: "MX",
          paymentMethod: "PIX",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a conclusive diagnosis with supporting steps", () => {
    expect(() => DiagnosisResultV0.parse(diagnosis)).not.toThrow();
  });

  it("rejects a conclusive diagnosis without supporting steps", () => {
    expect(() =>
      DiagnosisResultV0.parse({
        ...diagnosis,
        supportingStepNos: [],
      }),
    ).toThrow();
  });

  it("accepts a closed evidence object and narrative output", () => {
    const evidence = {
      schemaVersion: "0",
      request,
      diagnosis,
      onset: {
        startedAt: "2026-08-30T14:03:00.000Z",
        startedAtExact: true,
        evidenceBuckets: ["2026-08-30T14:03:00.000Z"],
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
        action: "Escalate provider BR/CARD routing to Adyen human support.",
        humanApprovalRequired: true,
      },
      repetitions: {
        fingerprint: request.incident.fingerprint,
        count: 1,
        priorIncidentIds: [],
      },
      audit: {
        runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
        actor: "agent",
        steps: [
          {
            stepNo: 1,
            toolCallId: "tool-1",
            toolName: "query_conversion_slice",
            toolArgs: { providerId: "adyen" },
            toolResult: { conversionRate: 0.51 },
            status: "completed",
            errorCode: null,
            decisionSummary: "Provider slice is degraded.",
            createdAt: "2026-08-30T14:06:01.000Z",
            completedAt: "2026-08-30T14:06:02.000Z",
          },
        ],
      },
    };

    expect(() => ProvisionalEvidenceObjectV0.parse(evidence)).not.toThrow();
    expect(() =>
      NarrativeOutputV0.parse({
        operations: "Provider BR/CARD degradation is costing 481200 USD minor units.",
        executive: "Incident cost is 481200 USD minor units and requires human approval.",
      }),
    ).not.toThrow();
  });
});
