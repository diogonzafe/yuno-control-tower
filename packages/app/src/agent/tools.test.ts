import type { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { InMemoryInvestigationAuditStore } from "./audit.js";
import { defaultMockScenario } from "./fixtures.js";
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

const sliceInput = {
  dimensions: {
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
  },
  windowBucket: "2026-08-30T14:06:00.000Z",
  decisionContext,
} as const;

function runContext(runId: string, maxToolCalls: number) {
  const auditStore = new InMemoryInvestigationAuditStore(runId, "agent");
  const requestContext = createInvestigationRequestContext({
    runId,
    maxToolCalls,
    auditStore,
    dataSource: createMockInvestigationDataSource(defaultMockScenario.toolResults),
    now: () => new Date("2026-08-30T14:06:00.000Z"),
  });
  return { auditStore, requestContext };
}

describe("investigationToolset with per-run RequestContext", () => {
  it("numbers steps across different tools of the same run", async () => {
    const { auditStore, requestContext } = runContext(
      "4dfbc6f5-70dd-47da-8cb1-b18b241647bf",
      12,
    );

    await investigationToolset.query_conversion_slice.execute!(sliceInput, toolContext(requestContext));
    // scan_incident_onset's schema takes detectedAt/expectedConversion/deltaPp
    // (not windowBucket); these values match the mock fixture registered under
    // defaultMockScenario so the call resolves instead of hitting "no mock
    // registered for input".
    await investigationToolset.scan_incident_onset.execute!(
      {
        dimensions: sliceInput.dimensions,
        detectedAt: sliceInput.windowBucket,
        expectedConversion: 0.92,
        deltaPp: 41,
        decisionContext: { ...decisionContext, tag: "CONFIRM_ONSET" as const },
      },
      toolContext(requestContext),
    );

    const trail = await auditStore.getTrail();
    // One counter per run, shared by every tool: a per-tool counter would make
    // the budget maxToolCalls * tool count and collide on (run_id, step_no).
    expect(trail.steps.map((step) => step.stepNo)).toEqual([1, 2]);
  });

  it("keeps two concurrent runs on separate budgets", async () => {
    const first = runContext("11111111-1111-4111-8111-111111111111", 12);
    const second = runContext("22222222-2222-4222-8222-222222222222", 12);

    await investigationToolset.query_conversion_slice.execute!(
      sliceInput,
      toolContext(first.requestContext),
    );
    await investigationToolset.query_conversion_slice.execute!(
      sliceInput,
      toolContext(second.requestContext),
    );

    expect((await first.auditStore.getTrail()).steps.map((s) => s.stepNo)).toEqual([1]);
    expect((await second.auditStore.getTrail()).steps.map((s) => s.stepNo)).toEqual([1]);
  });

  it("throws StepBudgetExceededError past the run's budget", async () => {
    const { requestContext } = runContext("33333333-3333-4333-8333-333333333333", 1);

    await investigationToolset.query_conversion_slice.execute!(sliceInput, toolContext(requestContext));

    await expect(
      investigationToolset.query_conversion_slice.execute!(sliceInput, toolContext(requestContext)),
    ).rejects.toBeInstanceOf(StepBudgetExceededError);
  });

  it("fails loudly when no run state is on the context", async () => {
    const { RequestContext } = await import("@mastra/core/request-context");
    await expect(
      investigationToolset.query_conversion_slice.execute!(
        sliceInput,
        toolContext(new RequestContext()),
      ),
    ).rejects.toThrow(/investigation run state/i);
  });
});
