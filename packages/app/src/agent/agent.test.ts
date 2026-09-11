import type { InvestigationAuditTrail, NarrationInput } from "@control-tower/contracts";
import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";
import { buildInvestigatorAgent } from "./agents/investigator.js";
import { buildNarratorAgent } from "./agents/narrator.js";
import { InMemoryInvestigationAuditStore } from "./audit.js";
import { loadAgentConfig } from "./config.js";
import { defaultMockScenario } from "./fixtures.js";
import { matchRecommendation } from "./playbooks.js";
import { renderNarratives } from "./narrator.js";
import { runInvestigation, validateConclusiveDiagnosis } from "./investigator.js";
import { stubModel, throwingModel } from "./testing/stub-model.js";
import {
  StepBudgetExceededError,
  createInvestigationRequestContext,
  createMockInvestigationDataSource,
  investigationToolset,
} from "./tools.js";

// Mastra's ToolExecutionContext requires `observe`; noopObserve is Mastra's
// own null-safe stand-in for when no tracing context is active, which is
// always true in these unit tests.
function toolContext(requestContext: RequestContext) {
  return { requestContext, observe: noopObserve };
}

const decisionContext = {
  tag: "DRILL_DOWN" as const,
  summary: "Checking the provider slice against its siblings.",
  hypothesis: { dimension: "provider" as const, value: "adyen" },
  basedOnStepNos: [],
};

describe("agent module", () => {
  it("runs the real Agent against a stub model", async () => {
    // The duck-typed InvestigatorAgentLike this replaces meant no test ever
    // exercised the tools, the schema or the processors — only our own mock.
    const agent = buildInvestigatorAgent(
      stubModel([
        {
          object: {
            status: "INCONCLUSIVE",
            conclusionTag: "STOP_INCONCLUSIVE",
            summary: "Not enough evidence.",
            supportingStepNos: [],
            reason: "INSUFFICIENT_EVIDENCE",
            missingEvidence: ["residual"],
          },
        },
      ]),
    );

    expect(agent.id).toBe("investigator");
    expect(Object.keys(await agent.listTools())).toContain("run_residual_test");
  });

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

  it("forwards RequestContext through the real Agent into a tool call (regression)", async () => {
    // The single most load-bearing claim of this phase: that Mastra forwards
    // the RequestContext runInvestigation builds into ToolExecutionContext
    // when a real Agent drives the call — not only when a test invokes
    // investigationToolset.<tool>.execute! directly, which every other test
    // in this file does. If Mastra ever stopped forwarding requestContext,
    // every production investigation would throw "Missing investigation run
    // state" on its first tool call, get classified MODEL_ERROR, and this
    // suite would still be green without a test exercising this path.
    const auditStore = new InMemoryInvestigationAuditStore(defaultMockScenario.request.runId, "agent");

    const agent = buildInvestigatorAgent(
      stubModel([
        // Step 1: the model issues a real tool call. Mastra must execute it
        // against investigationToolset with the RequestContext runInvestigation
        // built, which is what lets the tool find its run state at all.
        { toolCalls: [{ toolName: "query_conversion_slice", args: validSliceInput }] },
        // Step 2: with the tool result in hand, the model returns its
        // structured diagnosis.
        {
          object: {
            status: "INCONCLUSIVE",
            conclusionTag: "STOP_INCONCLUSIVE",
            selectedCell,
            summary: "Not enough evidence to conclude.",
            supportingStepNos: [1],
            causalDimension: null,
            declineFamily: null,
            reason: "INSUFFICIENT_EVIDENCE",
          },
        },
      ]),
    );

    const result = await runInvestigation({
      request: defaultMockScenario.request,
      config: loadAgentConfig({} as NodeJS.ProcessEnv),
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      agent,
      auditStore,
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    expect(result.outcome).toBe("COMPLETED");
    const trail = await auditStore.getTrail();
    expect(trail.steps).toHaveLength(1);
    expect(trail.steps[0]?.toolName).toBe("query_conversion_slice");
    expect(trail.steps[0]?.status).toBe("completed");
  });

  it("defaults the investigator and the narrator reserve to one model, the narrator to another", () => {
    // §6.8: narrator and reserve must not share a model, so one model's rate
    // limit cannot take both down. The investigator shares the reserve's model
    // because the two rarely run at once — the reserve only wakes after the
    // narrator has already failed.
    expect(loadAgentConfig({} as NodeJS.ProcessEnv)).toEqual({
      investigatorModel: "openai/gpt-5.6-luna",
      narratorModel: "openai/gpt-5.6-terra",
      narratorFallbackModel: "openai/gpt-5.6-luna",
      maxToolCalls: 12,
      maxSteps: 12,
      timeoutMs: 45_000,
      // The deterministic fallback ships off; AGENT_FALLBACK_ENABLED=true opts in.
      fallbackEnabled: false,
    });
  });

  it("reads the step ceiling separately from the tool budget", () => {
    const config = loadAgentConfig({
      AGENT_MAX_TOOL_CALLS: "12",
      AGENT_MAX_STEPS: "20",
    } as NodeJS.ProcessEnv);
    // A model step may issue several tool calls, so tying maxSteps to the tool
    // budget cuts the conversation off before its conclusion — the run then
    // returns finishReason "tool-calls" with no object and reads as
    // INVALID_OUTPUT on a run that did nothing wrong.
    expect(config.maxToolCalls).toBe(12);
    expect(config.maxSteps).toBe(20);
  });

  it("defaults the step ceiling to 12", () => {
    expect(loadAgentConfig({} as NodeJS.ProcessEnv).maxSteps).toBe(12);
  });

  it("falls the step ceiling back to the tool budget when only AGENT_MAX_TOOL_CALLS is set", () => {
    // Before this phase, maxSteps received config.maxToolCalls directly. A
    // deployment with AGENT_MAX_TOOL_CALLS=20 and no AGENT_MAX_STEPS set must
    // still get a 20-step loop, not silently drop to the new field's own
    // default of 12 — that would cut runs off before their conclusion, the
    // exact pathology the maxSteps/maxToolCalls split exists to remove.
    const config = loadAgentConfig({ AGENT_MAX_TOOL_CALLS: "20" } as NodeJS.ProcessEnv);
    expect(config.maxToolCalls).toBe(20);
    expect(config.maxSteps).toBe(20);
  });

  it("records structured audit entries for deterministic tools", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );
    const requestContext = createInvestigationRequestContext({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 12,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    const result = await investigationToolset.query_conversion_slice.execute!(
      validSliceInput,
      toolContext(requestContext),
    );
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
    const requestContext = createInvestigationRequestContext({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 1,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    await investigationToolset.query_conversion_slice.execute!(validSliceInput, toolContext(requestContext));

    await expect(
      investigationToolset.query_conversion_slice.execute!(validSliceInput, toolContext(requestContext)),
    ).rejects.toBeInstanceOf(StepBudgetExceededError);
  });

  it("numbers steps once per run, not once per tool", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );
    const requestContext = createInvestigationRequestContext({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 12,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    // Two DIFFERENT tools. A per-tool counter would number both as step 1,
    // colliding on investigation_steps' (run_id, step_no) primary key and
    // making cross-tool basedOnStepNos unresolvable.
    await investigationToolset.query_conversion_slice.execute!(validSliceInput, toolContext(requestContext));
    await investigationToolset.query_decline_mix.execute!(
      {
        dimensions: selectedCell,
        windowBucket: "2026-08-30T14:06:00.000Z",
        decisionContext,
      },
      toolContext(requestContext),
    );

    const trail = await auditStore.getTrail();
    expect(trail.steps.map((step) => step.stepNo)).toEqual([1, 2]);
    expect(trail.steps.map((step) => step.toolName)).toEqual([
      "query_conversion_slice",
      "query_decline_mix",
    ]);
  });

  it("counts the budget across tools, not per tool", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );
    const requestContext = createInvestigationRequestContext({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 1,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    await investigationToolset.query_conversion_slice.execute!(validSliceInput, toolContext(requestContext));

    // The budget is per run (rules.md §6.8, roadmap H+13: 12 calls per run), so a
    // second call to a DIFFERENT tool must exhaust it too.
    await expect(
      investigationToolset.query_decline_mix.execute!(
        {
          dimensions: selectedCell,
          windowBucket: "2026-08-30T14:06:00.000Z",
          decisionContext,
        },
        toolContext(requestContext),
      ),
    ).rejects.toBeInstanceOf(StepBudgetExceededError);
  });

  it("rejects references to future steps", async () => {
    const auditStore = new InMemoryInvestigationAuditStore(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      "agent",
    );
    const requestContext = createInvestigationRequestContext({
      runId: "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      maxToolCalls: 12,
      auditStore,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    await expect(
      investigationToolset.query_conversion_slice.execute!(
        {
          ...validSliceInput,
          decisionContext: { ...decisionContext, basedOnStepNos: [1] },
        },
        toolContext(requestContext),
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
      agent: buildInvestigatorAgent(stubModel([{ object: { status: "CONCLUSIVE" } }])),
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
      buildNarratorAgent(
        "narrator",
        stubModel([
          {
            object: {
              operations: "Impact is 999 USD minor units.",
              executive: "Escalate now.",
            },
          },
        ]),
      ),
      buildNarratorAgent("narrator-fallback", throwingModel("fallback model failed")),
    );

    expect(output.executive).toContain("160400");
  });

  it("blocks a fabricated number even from an agent not built by buildNarratorAgent", async () => {
    // Boundary #2 must hold at the call site, not only inside the processor
    // buildNarratorAgent wires up. An agent constructed some other way (or a
    // generate() call that forgets to set NARRATION_INPUT_KEY, which makes
    // agents/narrator.ts's resolver return []) carries no
    // EvidenceNumbersProcessor at all — render() itself is what must still
    // catch the fabrication.
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

    const bareAgent = new Agent({
      id: "bare-narrator",
      name: "Bare Narrator",
      instructions: "Narrate freely.",
      model: stubModel([
        {
          object: {
            operations: "Impact is 999 USD minor units.",
            executive: "Escalate now.",
          },
        },
      ]),
      // Deliberately no outputProcessors: this is the "agent not built by
      // buildNarratorAgent" this test exists to cover.
    });

    const output = await renderNarratives(
      loadAgentConfig({} as NodeJS.ProcessEnv),
      narrationInput,
      bareAgent,
      buildNarratorAgent("narrator-fallback", throwingModel("fallback model failed")),
    );

    // Falls all the way through to the template: the bare primary's
    // fabricated 999 must never reach the caller, and the throwing fallback
    // never produces a usable narrative either.
    expect(output.executive).toContain("160400");
    expect(output.executive).not.toContain("999");
  });

  it("forwards maxSteps from config.maxSteps, not config.maxToolCalls", async () => {
    // Regression test: maxSteps and maxToolCalls were once conflated. This
    // asserts they are separate by verifying the agent receives the value
    // from its own config field, not the tool budget.
    let capturedMaxSteps: number | undefined;

    const agent = buildInvestigatorAgent(
      stubModel([
        {
          object: {
            status: "INCONCLUSIVE",
            conclusionTag: "STOP_INCONCLUSIVE",
            selectedCell,
            summary: "Not enough data.",
            supportingStepNos: [],
            causalDimension: null,
            declineFamily: null,
            reason: "INSUFFICIENT_EVIDENCE",
          },
        },
      ]),
    );

    // Spy on the real instance rather than rebuilding it: `{ ...agent }`
    // spreads only own enumerable properties, dropping the Agent prototype
    // (listTools, etc.) — harmless today because runInvestigation calls
    // nothing but generate(), but a trap for the next caller that does.
    const original = agent.generate.bind(agent);
    vi.spyOn(agent, "generate").mockImplementation(((
      prompt: string,
      options: { maxSteps?: number } & Record<string, unknown>,
    ) => {
      capturedMaxSteps = options.maxSteps;
      // `never` is assignable to every overload's options parameter; the
      // outer cast to `typeof agent.generate` is what makes this mock
      // assignable back onto the real (overloaded) method.
      return original(prompt, options as never);
    }) as typeof agent.generate);

    const config = loadAgentConfig({
      AGENT_MAX_TOOL_CALLS: "12",
      AGENT_MAX_STEPS: "20",
    } as NodeJS.ProcessEnv);

    // Run with the config where maxSteps != maxToolCalls.
    // If the fix is reverted and investigator.ts uses config.maxToolCalls
    // for maxSteps, this test fails.
    const result = await runInvestigation({
      request: defaultMockScenario.request,
      config,
      dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
      agent,
      now: () => new Date("2026-08-30T14:06:00.000Z"),
    });

    // The run must complete cleanly: a failing run (missing wire fields)
    // used to dump a large MastraError to stderr on every suite run even
    // though this assertion only cares about the captured value.
    expect(result.outcome).toBe("COMPLETED");

    // Verify the fix: maxSteps came from config.maxSteps (20),
    // not config.maxToolCalls (12). If someone reverts the fix in
    // investigator.ts:223 to use config.maxToolCalls, this assertion fails.
    expect(capturedMaxSteps).toBe(20);
  });
});
