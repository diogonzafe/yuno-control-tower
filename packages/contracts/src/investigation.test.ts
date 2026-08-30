import { describe, expect, it } from "vitest";
import {
  AgentDiagnosis,
  AgentRunResult,
  DecisionContext,
  InvestigationAuditStep,
  InvestigationRequestV1,
  NarrationInput,
  NarrativeOutput,
} from "./index.js";

const request = {
  schemaVersion: "1",
  runId: "62f4aa31-a6d6-4b60-bf31-95037bb6b5f2",
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
    rootDimensions: {
      merchantId: "merchant-1",
      country: "BR",
    },
    similarIncidents: [],
  },
} as const;

const step = {
  stepNo: 1,
  toolCallId: "62f4aa31-a6d6-4b60-bf31-95037bb6b5f2:1:query_conversion_slice",
  toolName: "query_conversion_slice",
  toolArgs: { providerId: "adyen" },
  toolResult: { conversionRate: 0.51 },
  status: "completed",
  errorCode: null,
  decisionTag: "DRILL_DOWN",
  decisionSummary: "Provider slice is degraded.",
  hypothesis: { dimension: "provider", value: "adyen" },
  evidenceStepNos: [],
  createdAt: "2026-08-30T14:06:01.000Z",
  completedAt: "2026-08-30T14:06:02.000Z",
} as const;

describe("investigation contracts", () => {
  it("accepts a well-formed investigation request", () => {
    expect(() => InvestigationRequestV1.parse(request)).not.toThrow();
  });

  it("rejects PIX outside BR in routing validation", () => {
    const result = InvestigationRequestV1.safeParse({
      ...request,
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

  it("rejects PIX slices with issuer different from NA", () => {
    const result = InvestigationRequestV1.safeParse({
      ...request,
      trigger: {
        ...request.trigger,
        dimensions: {
          ...request.trigger.dimensions,
          paymentMethod: "PIX",
          issuerId: "itau",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts public decision contexts and rejects <thinking>", () => {
    expect(() =>
      DecisionContext.parse({
        tag: "DRILL_DOWN",
        summary: "Checking the provider slice against its siblings.",
        hypothesis: { dimension: "provider", value: "adyen" },
        basedOnStepNos: [],
      }),
    ).not.toThrow();

    expect(() =>
      DecisionContext.parse({
        tag: "DRILL_DOWN",
        summary: "<thinking>hidden</thinking>",
        hypothesis: null,
        basedOnStepNos: [],
      }),
    ).toThrow();
  });

  it("accepts conclusive diagnosis and audit step", () => {
    expect(() =>
      AgentDiagnosis.parse({
        status: "CONCLUSIVE",
        conclusionTag: "STOP_CONCLUSIVE",
        selectedCell: request.trigger.dimensions,
        causalDimension: "provider",
        declineFamily: "network",
        summary: "Provider degradation in BR card traffic explains the drop.",
        supportingStepNos: [1],
      }),
    ).not.toThrow();
    expect(() => InvestigationAuditStep.parse(step)).not.toThrow();
  });

  it("accepts narration input and narrative output", () => {
    const input = {
      evidence: {
        fingerprint: "country=BR|merchantId=merchant-1|providerId=adyen#91",
        dimensions: request.trigger.dimensions,
        observedRate: 0.51,
        expectedRate: 0.92,
        expectedSource: "cross_sectional",
        deltaPp: 41,
        ci: { low: 0.47, high: 0.55, level: 0.95 },
        attempts: 420,
        approved: 214,
        windowBucket: "2026-08-30T14:06:00.000Z",
        windowUsed: "1m",
        consecutiveWindows: 3,
        startedAt: "2026-08-30T14:03:00.000Z",
        startedAtExact: true,
        declineMix: [],
        dominantDecline: "91",
        suppressedEchoes: [],
        lostApprovals: 173,
        costUsdMinor: 481200,
        costUsdPerMin: 160400,
        costLocal: { BRL: 2500000 },
        priorityScore: 88.2,
        diagnosisSource: "agent",
        investigationTrail: [step],
      },
      recommendation: {
        playbookId: "provider-default",
        owner: "provider-ops",
        title: "Provider degradation escalation",
        summary: "Escalate the provider owner and prepare a rerouting proposal.",
        actions: ["Open the provider escalation."],
        humanApprovalRequired: true,
      },
    };

    expect(() => NarrationInput.parse(input)).not.toThrow();
    expect(() =>
      NarrativeOutput.parse({
        operations: "Provider slice is degraded and costs 160400 USD minor units per minute.",
        executive: "Cost is 160400 USD minor units per minute.",
      }),
    ).not.toThrow();
  });

  it("accepts a completed agent run without provisional evidence", () => {
    expect(() =>
      AgentRunResult.parse({
        outcome: "COMPLETED",
        runId: request.runId,
        diagnosis: {
          status: "CONCLUSIVE",
          conclusionTag: "STOP_CONCLUSIVE",
          selectedCell: request.trigger.dimensions,
          causalDimension: "provider",
          declineFamily: "network",
          summary: "Provider degradation in BR card traffic explains the drop.",
          supportingStepNos: [1],
        },
        audit: {
          runId: request.runId,
          actor: "agent",
          steps: [step],
        },
        toolCallsUsed: 1,
        startedAt: "2026-08-30T14:06:00.000Z",
        completedAt: "2026-08-30T14:06:02.000Z",
      }),
    ).not.toThrow();
  });
});
