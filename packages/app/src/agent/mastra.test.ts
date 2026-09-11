import { describe, expect, it } from "vitest";
import { getInvestigatorAgent, getMastra, getNarratorAgent, getNarratorFallbackAgent } from "./mastra.js";

describe("mastra root", () => {
  it("registers the investigator and both narrator roles", () => {
    expect(Object.keys(getMastra().listAgents()).sort()).toEqual([
      "investigator",
      "narrator",
      "narrator-fallback",
    ]);
  });

  it("returns the same agent instance on repeated resolution", () => {
    // The defect this replaces: new Agent() ran inside runInvestigation and
    // inside every narration, so nothing was ever registered and tracing
    // and Studio had nothing to observe.
    expect(getInvestigatorAgent()).toBe(getInvestigatorAgent());
    expect(getNarratorAgent()).toBe(getNarratorAgent());
  });

  it("keeps the narrator and its reserve on different models (§6.8)", async () => {
    // One model's rate limit must not take both down. not.toBe on the
    // Agent instances only proves they're distinct objects (construction
    // guarantees that anyway); asserting on loadAgentConfig() only proves
    // the config's own defaults differ, which agent.test.ts's defaults test
    // already covers and says nothing about the *registered* agents this
    // file exists to test. Resolve what the two agents this root actually
    // wires up will call, and assert those differ.
    const narratorModel = await getNarratorAgent().getModel();
    const fallbackModel = await getNarratorFallbackAgent().getModel();
    expect((narratorModel as { modelId: string }).modelId).not.toBe(
      (fallbackModel as { modelId: string }).modelId,
    );
  });
});
