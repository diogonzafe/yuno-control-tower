export interface AgentConfig {
  investigatorModel: string;
  narratorModel: string;
  narratorFallbackModel: string;
  maxToolCalls: number;
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
    // Deliberately all on Kimi now (moved off the rules.md §6.4.1 OpenAI
    // split) — the reserve no longer being a different model than the
    // narrator's means a Kimi-side rate limit takes both down together
    // (§6.8's original reasoning for keeping them apart); accepted knowingly.
    investigatorModel: env.INVESTIGATOR_MODEL ?? "kimi-for-coding/k3",
    narratorModel: env.NARRATOR_MODEL ?? "kimi-for-coding/k3",
    narratorFallbackModel: env.NARRATOR_FALLBACK_MODEL ?? "kimi-for-coding/k3",
    maxToolCalls: readPositiveInt(env.AGENT_MAX_TOOL_CALLS, 12),
    timeoutMs: readPositiveInt(env.AGENT_TIMEOUT_MS, 45_000),
    fallbackEnabled: readFallbackEnabled(env.AGENT_FALLBACK_ENABLED),
  };
}
