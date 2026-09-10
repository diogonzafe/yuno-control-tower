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

  it("keeps the narrator and its reserve on different models (§6.8)", () => {
    // One model's rate limit must not take both down.
    expect(getNarratorAgent()).not.toBe(getNarratorFallbackAgent());
  });
});
