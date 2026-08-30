import { describe, expect, it } from "vitest";
import { MockEvidenceProvider } from "./evidence-provider.js";
import { defaultMockScenario } from "./fixtures.js";
import { InMemoryInvestigationAuditStore } from "./audit.js";
import {
  StepBudgetExceededError,
  createInvestigationToolset,
  createMockInvestigationDataSource,
} from "./tools.js";
import { loadAgentConfig } from "./config.js";
import { renderNarratives } from "./narrator.js";
import { runInvestigation, validateConclusiveDiagnosis } from "./investigator.js";

describe("agent module", () => {
  const validSliceInput = {
    dimensions: {
      merchantId: "merchant-1",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "NA",
    },
    windowBucket: "2026-08-30T14:06:00.000Z",
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

  it("returns mock evidence for the known scenario", async () => {
    const provider = new MockEvidenceProvider(defaultMockScenario);
    await expect(provider.getEvidence(defaultMockScenario.request)).resolves.toEqual(
      defaultMockScenario.evidence,
    );
  });

  it("records tool audit entries for deterministic tools", async () => {
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

    const executeSlice = tools.query_conversion_slice.execute!;
    const result = await executeSlice(validSliceInput, {} as never);
    if (!result || typeof result !== "object" || !("conversionRate" in result)) {
      throw new Error("Expected a conversion slice result");
    }

    expect(result.conversionRate).toBe(0.51);
    const trail = await auditStore.getTrail();
    expect(trail.steps).toHaveLength(1);
    expect(trail.steps[0]?.toolName).toBe("query_conversion_slice");
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

    const executeSlice = tools.query_conversion_slice.execute!;
    await executeSlice(validSliceInput, {} as never);

    await expect(
      executeSlice(validSliceInput, {} as never),
    ).rejects.toBeInstanceOf(StepBudgetExceededError);
  });

  it("rejects a conclusive diagnosis without residual/onset/impact evidence", () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );

    const genericCompletedStep = (stepNo: number) =>
      auditStore.recordStep({
        stepNo,
        toolCallId: `tool-${stepNo}`,
        toolName: stepNo === 6 ? "query_decline_mix" : "query_conversion_slice",
        toolArgs: { providerId: "adyen" },
        toolResult: { conversionRate: 0.51 },
        status: "completed",
        errorCode: null,
        decisionSummary: "Provider slice is degraded",
        createdAt: "2026-08-30T14:06:00.000Z",
        completedAt: "2026-08-30T14:06:00.000Z",
      });

    return Promise.all([1, 2, 3, 4, 5, 6].map((stepNo) => genericCompletedStep(stepNo))).then(
      async () => {
        const trail = await auditStore.getTrail();
        expect(() =>
          validateConclusiveDiagnosis(defaultMockScenario.investigatorDiagnosis, trail),
        ).toThrow(/required evidence/);
      },
    );
  });

  it("fails the run when the agent output is invalid", async () => {
    const result = await runInvestigation({
      request: defaultMockScenario.request,
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      config: loadAgentConfig({} as NodeJS.ProcessEnv),
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      evidenceProvider: new MockEvidenceProvider(defaultMockScenario),
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

  it("rejects narrator output that invents numbers", async () => {
    await expect(
      renderNarratives(loadAgentConfig({} as NodeJS.ProcessEnv), defaultMockScenario.evidence, {
        async generate() {
          return {
            object: {
              operations: "Impact is 999 USD minor units.",
              executive: "Escalate now.",
            },
          };
        },
      }),
    ).rejects.toThrow(/not present in the evidence object/);
  });
});
