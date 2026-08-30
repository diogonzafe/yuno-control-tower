import { Agent } from "@mastra/core/agent";
import {
  NarrativeOutputV0,
  type NarrativeOutputV0 as NarrativeOutputV0Type,
  type ProvisionalEvidenceObjectV0,
} from "@control-tower/contracts";
import type { AgentConfig } from "./config.js";

export interface NarratorAgentLike {
  generate(
    prompt: string,
    options: Record<string, unknown>,
  ): Promise<{ object?: unknown }>;
}

export function createNarratorAgent(config: AgentConfig): Agent {
  return new Agent({
    id: "incident-narrator",
    name: "Incident Narrator",
    instructions:
      "You narrate a closed payment-incident evidence object. Never calculate new numbers and never add numbers that are not present in the evidence object.",
    model: config.narratorModel,
  });
}

export function buildNarratorPrompt(evidence: ProvisionalEvidenceObjectV0): string {
  return [
    "Write two short narratives from the evidence object.",
    "The first is for operations. The second is for executives.",
    "Do not invent any number, percentage, duration, count, date, or currency amount.",
    JSON.stringify(evidence),
  ].join("\n");
}

function collectAllowedNumbers(value: unknown, collector: Set<string>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    collector.add(value.toString());
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAllowedNumbers(item, collector);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectAllowedNumbers(nested, collector);
    }
  }
}

export function assertNarrativeUsesOnlyEvidenceNumbers(
  text: string,
  evidence: ProvisionalEvidenceObjectV0,
): void {
  const allowedNumbers = new Set<string>();
  collectAllowedNumbers(evidence, allowedNumbers);

  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  for (const match of matches) {
    if (!allowedNumbers.has(match)) {
      throw new Error(`Narrative introduced a number not present in the evidence object: ${match}`);
    }
  }
}

export async function renderNarratives(
  config: AgentConfig,
  evidence: ProvisionalEvidenceObjectV0,
  agent?: NarratorAgentLike,
): Promise<NarrativeOutputV0Type> {
  const narrator = agent ?? createNarratorAgent(config);
  const response = await narrator.generate(buildNarratorPrompt(evidence), {
    structuredOutput: {
      schema: NarrativeOutputV0,
      errorStrategy: "strict",
      jsonPromptInjection: true,
    },
    modelSettings: {
      maxRetries: 0,
    },
  });
  const output = NarrativeOutputV0.parse(response.object);
  assertNarrativeUsesOnlyEvidenceNumbers(output.operations, evidence);
  assertNarrativeUsesOnlyEvidenceNumbers(output.executive, evidence);
  return output;
}
