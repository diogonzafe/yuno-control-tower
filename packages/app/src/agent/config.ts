export interface AgentConfig {
  investigatorModel: string;
  narratorModel: string;
  narratorFallbackModel: string;
  maxToolCalls: number;
  maxSteps: number;
  timeoutMs: number;
  fallbackEnabled: boolean;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`);
  }

  return parsed;
}

// The deterministic fallback is off by default: a failed investigation leaves
// the incident with the deterministic evidence orchestrate/incidents.ts already
// wrote at tick time (boundary #3, one layer down) and skips the extra beam
// search + narrator run. An operator opts back in with AGENT_FALLBACK_ENABLED
// set to the literal "true"; anything else leaves it off.
function readFallbackEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    // Back on OpenAI (3751c26 had moved all three to Kimi). Measured
    // 2026-09-10: no provider in @mastra or ai resolves a Kimi model id, so
    // every call failed and renderNarratives silently served its deterministic
    // narrative — an incident read as narrated when nothing had narrated it.
    // A default that cannot work is worse than none, so these are the ids the
    // deployment actually runs on.
    //
    // The narrator and its reserve stay on different models, which is §6.8's
    // reason for keeping them apart: one model's rate limit must not take both
    // down. The investigator shares the reserve's model — the two rarely run at
    // once, since the reserve only wakes when the narrator has already failed.
    investigatorModel: env.INVESTIGATOR_MODEL ?? "openai/gpt-5.6-luna",
    narratorModel: env.NARRATOR_MODEL ?? "openai/gpt-5.6-terra",
    narratorFallbackModel: env.NARRATOR_FALLBACK_MODEL ?? "openai/gpt-5.6-luna",
    maxToolCalls: readPositiveInt(env.AGENT_MAX_TOOL_CALLS, 12),
    // A model step may issue several tool calls, so this is not the tool
    // budget. maxToolCalls stays the hard cap on work done
    // (StepBudgetExceededError); this only stops Mastra from ending the
    // conversation before the model reaches its conclusion.
    //
    // Defaults to the tool budget, not a bare 12: before this field existed,
    // maxSteps received config.maxToolCalls directly, so a deployment with
    // only AGENT_MAX_TOOL_CALLS set in its environment must keep getting a
    // loop that long rather than silently dropping to this field's own
    // default. (A next-phase improvement would default to maxToolCalls + 1,
    // since the step that emits the final answer consumes a step of its own
    // — deliberately not done here, as that would be a behaviour change.)
    maxSteps: readPositiveInt(env.AGENT_MAX_STEPS, readPositiveInt(env.AGENT_MAX_TOOL_CALLS, 12)),
    timeoutMs: readPositiveInt(env.AGENT_TIMEOUT_MS, 45_000),
    fallbackEnabled: readFallbackEnabled(env.AGENT_FALLBACK_ENABLED),
  };
}
