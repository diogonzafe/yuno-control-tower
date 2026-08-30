import type { InvestigationAuditTrail, NarrationInput } from "@control-tower/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryInvestigationAuditStore } from "./audit.js";
import { loadAgentConfig } from "./config.js";
import { defaultMockScenario } from "./fixtures.js";
import { matchRecommendation } from "./playbooks.js";
import { renderNarratives } from "./narrator.js";
import { runInvestigation, validateConclusiveDiagnosis } from "./investigator.js";
import {
  StepBudgetExceededError,
  createInvestigationToolset,
  createMockInvestigationDataSource,
} from "./tools.js";

const decisionContext = {
  tag: "DRILL_DOWN" as const,
  summary: "Checking the provider slice against its siblings.",
  hypothesis: { dimension: "provider" as const, value: "adyen" },
  basedOnStepNos: [],
};

describe("agent module", () => {
  const selectedCell = {
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
  } as const;
  const validSliceInput = {
    dimensions: selectedCell,
    windowBucket: "2026-08-30T14:06:00.000Z",
    decisionContext,
  } as const;

  it("loads gpt-5.4 defaults for investigator and narrator", () => {
    expect(loadAgentConfig({} as NodeJS.ProcessEnv)).toEqual({
      investigatorModel: "openai/gpt-5.4",
      narratorModel: "openai/gpt-5.4",
      narratorFallbackModel: "openai/gpt-5.4",
      maxToolCalls: 12,
      timeoutMs: 45_000,
    });
  });

  it("records structured audit entries for deterministic tools", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );
    const tools = createInvestigationToolset({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 12,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    const result = await tools.query_conversion_slice.execute!(validSliceInput, {} as never);
    if (!result || typeof result !== "object" || !("conversionRate" in result)) {
      throw new Error("Expected a conversion slice result");
    }

    expect(result.conversionRate).toBe(0.51);
    const trail = await auditStore.getTrail();
    expect(trail.steps).toHaveLength(1);
    expect(trail.steps[0]?.decisionTag).toBe("DRILL_DOWN");
    expect(trail.steps[0]?.hypothesis).toEqual({ dimension: "provider", value: "adyen" });
  });

  it("enforces the tool-call budget", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );
    const tools = createInvestigationToolset({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 1,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    await tools.query_conversion_slice.execute!(validSliceInput, {} as never);

    await expect(
      tools.query_conversion_slice.execute!(validSliceInput, {} as never),
    ).rejects.toBeInstanceOf(StepBudgetExceededError);
  });

  it("rejects references to future steps", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );
    const tools = createInvestigationToolset({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 12,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    await expect(
      tools.query_conversion_slice.execute!(
        {
          ...validSliceInput,
          decisionContext: { ...decisionContext, basedOnStepNos: [1] },
        },
        {} as never,
      ),
    ).rejects.toThrow(/future step/);
  });

  it("rejects a conclusive diagnosis without residual/onset/impact evidence", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );

    const genericCompletedStep = (stepNo: number) =>
      auditStore.recordStep({
        stepNo,
        toolCallId: `4dfbc6f5-70dd-47da-8cb1-b18b241647bf:${stepNo}:query_conversion_slice`,
        toolName: "query_conversion_slice",
        toolArgs: { providerId: "adyen" },
        toolResult: { conversionRate: 0.51 },
        status: "completed",
        errorCode: null,
        decisionTag: "DRILL_DOWN",
        decisionSummary: "Provider slice is degraded",
        hypothesis: { dimension: "provider", value: "adyen" },
        evidenceStepNos: [],
        createdAt: "2026-08-30T14:06:00.000Z",
        completedAt: "2026-08-30T14:06:00.000Z",
      });

    await Promise.all([1, 2, 3].map((stepNo) => genericCompletedStep(stepNo)));
    const trail = await auditStore.getTrail();
    expect(() => validateConclusiveDiagnosis(defaultMockScenario.diagnosis, trail)).toThrow(
      /required evidence/,
    );
  });

  it("fails the run when the agent output is invalid", async () => {
    const result = await runInvestigation({
      request: defaultMockScenario.request,
      config: loadAgentConfig({} as NodeJS.ProcessEnv),
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      agent: {
        async generate() {
          return { object: { status: "CONCLUSIVE" } };
        },
      },
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    expect(result.outcome).toBe("FAILED");
    if (result.outcome === "FAILED") {
      expect(result.failureCode).toBe("INVALID_OUTPUT");
    }
  });

  it("matches the deterministic provider playbook", () => {
    const recommendation = matchRecommendation({
      root: { merchantId: "merchant-1", country: "BR" },
      cell: {
        merchantId: "merchant-1",
        providerId: "adyen",
        country: "BR",
        paymentMethod: "CARD",
        issuerId: "itau",
      },
      causalDimension: "provider",
      confidence: "CONFIRMED",
      windowBucket: "2026-08-30T14:06:00.000Z",
      startedAt: "2026-08-30T14:03:00.000Z",
      startedAtExact: true,
      attempts: 420,
      approved: 214,
      observedRate: 0.51,
      expectedRate: 0.92,
      expectedSource: "cross_sectional",
      deltaPp: 41,
      ci: { low: 0.47, high: 0.55 },
      ciLevel: 0.95,
      windowUsed: "1m",
      consecutiveWindows: 3,
      explainedDeficit: 38.5,
      declineMix: {
        totalDeclines: 207,
        windowUsed: 5,
        referenceSource: "catalog",
        dominantCode: "91",
        shifts: [
          {
            code: "91",
            family: "network",
            diagnostic: true,
            count: 118,
            observedShare: 0.57,
            referenceShare: 0.02,
            deltaPp: 55,
          },
        ],
      },
      outageAttribution: "PROVIDER",
      impact: {
        durationMin: 4,
        lostApprovals: 173,
        avgTicketUsdMinor: 2782,
        costUsdMinor: 481200,
        costLocal: { BRL: 2500000 },
        costUsdPerMin: 160400,
        priorityScore: 88.2,
      },
      suppressedEchoes: [],
    });

    expect(recommendation?.playbookId).toBe("provider-default");
    expect(recommendation?.humanApprovalRequired).toBe(true);
  });

  it("rejects narrator output that invents numbers and falls back to template", async () => {
    const narrationInput: NarrationInput = {
      evidence: {
        fingerprint: "country=BR|merchantId=merchant-1|providerId=adyen#91",
        dimensions: selectedCell,
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
        investigationTrail: [] as InvestigationAuditTrail["steps"],
      },
      recommendation: defaultMockScenario.recommendation,
    };

    const output = await renderNarratives(
      loadAgentConfig({} as NodeJS.ProcessEnv),
      narrationInput,
      {
        async generate() {
          return {
            object: {
              operations: "Impact is 999 USD minor units.",
              executive: "Escalate now.",
            },
          };
        },
      },
      {
        async generate() {
          throw new Error("fallback model failed");
        },
      },
    );

    expect(output.executive).toContain("160400");
  });
});
