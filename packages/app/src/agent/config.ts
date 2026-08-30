export interface AgentConfig {
  investigatorModel: string;
  narratorModel: string;
  narratorFallbackModel: string;
  maxToolCalls: number;
  timeoutMs: number;
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

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    // rules.md §6.4.1 locks one model per role. The reserve must differ from
    // the narrator's, or a rate limit on the narrator takes the reserve with it
    // (§6.8). All three ids verified against the provider's model list.
    investigatorModel: env.INVESTIGATOR_MODEL ?? "openai/gpt-5.6-sol",
    narratorModel: env.NARRATOR_MODEL ?? "openai/gpt-5.6-terra",
    narratorFallbackModel: env.NARRATOR_FALLBACK_MODEL ?? "openai/gpt-5.6-luna",
    maxToolCalls: readPositiveInt(env.AGENT_MAX_TOOL_CALLS, 12),
    timeoutMs: readPositiveInt(env.AGENT_TIMEOUT_MS, 45_000),
  };
}
