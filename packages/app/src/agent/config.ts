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
    investigatorModel: env.INVESTIGATOR_MODEL ?? "openai/gpt-5.4",
    narratorModel: env.NARRATOR_MODEL ?? "openai/gpt-5.4",
    narratorFallbackModel: env.NARRATOR_FALLBACK_MODEL ?? "openai/gpt-5.4",
    maxToolCalls: readPositiveInt(env.AGENT_MAX_TOOL_CALLS, 12),
    timeoutMs: readPositiveInt(env.AGENT_TIMEOUT_MS, 45_000),
  };
}
