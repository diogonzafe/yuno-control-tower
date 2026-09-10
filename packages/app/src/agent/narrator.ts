import type { Agent } from "@mastra/core/agent";
import {
  NarrativeOutput,
  NarrationInput,
  type NarrativeOutput as NarrativeOutputType,
  type NarrationInput as NarrationInputType,
} from "@control-tower/contracts";
import type { AgentConfig } from "./config.js";
import { getNarratorAgent, getNarratorFallbackAgent } from "./mastra.js";

export function buildNarratorPrompt(input: NarrationInputType): string {
  return [
    "Write two short narratives from the closed evidence object and optional recommendation.",
    "The first is for operations. The second is for executives.",
    "Do not invent any number, percentage, duration, count, date, or currency amount.",
    JSON.stringify(input),
  ].join("\n");
}

function collectAllowedNumbers(value: unknown, collector: Set<string>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    collector.add(value.toString());
    // A rate is stored as 0.12 but read aloud as "12%". Admitting the
    // percentage form is not a loophole — the number still has to come from a
    // field of the evidence object; it just may be spoken the way an operator
    // speaks it. Without this every readable narrative would be rejected and
    // fall back to the template, defeating spec.md §4 criterion 4.
    if (value >= 0 && value <= 1) {
      const asPercent = value * 100;
      collector.add(asPercent.toString());
      collector.add(Math.round(asPercent).toString());
      collector.add(asPercent.toFixed(1));
    }
    return;
  }

  if (typeof value === "string") {
    const matches = value.match(/-?\d+(?:\.\d+)?/g) ?? [];
    for (const match of matches) {
      collector.add(match);
    }
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
  input: NarrationInputType,
): void {
  const allowedNumbers = new Set<string>();
  collectAllowedNumbers(input, allowedNumbers);

  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  for (const match of matches) {
    if (!allowedNumbers.has(match)) {
      throw new Error(`Narrative introduced a number not present in the evidence object: ${match}`);
    }
  }
}

function renderNarrativeTemplate(input: NarrationInputType): NarrativeOutputType {
  const { evidence, recommendation } = input;
  const dimensionSummary = [
    evidence.dimensions.providerId,
    evidence.dimensions.country,
    evidence.dimensions.paymentMethod,
    evidence.dimensions.issuerId,
  ]
    .filter(Boolean)
    .join(" / ");
  const recommendationText = recommendation
    ? `${recommendation.owner}: ${recommendation.actions.join("; ")}`
    : "No human action playbook matched yet.";

  return {
    operations: `Conversion fell to ${evidence.observedRate} from ${evidence.expectedRate} in ${dimensionSummary} since ${evidence.startedAt}. Recommendation: ${recommendationText}`,
    executive: `Incident costs at least ${evidence.costUsdPerMin} USD minor units per minute. Recommendation: ${recommendationText}`,
  };
}

export async function renderNarratives(
  // Kept for signature compatibility with existing call sites (coordinator.ts,
  // agent.test.ts); model selection now lives on the Mastra root, resolved via
  // getNarratorAgent()/getNarratorFallbackAgent() below.
  _config: AgentConfig,
  input: NarrationInputType,
  agent?: Agent,
  fallbackAgent?: Agent,
): Promise<NarrativeOutputType> {
  const parsedInput = NarrationInput.parse(input);
  const primary = agent ?? getNarratorAgent();
  const secondary = fallbackAgent ?? getNarratorFallbackAgent();
  const render = async (runner: Agent) => {
    const response = await runner.generate(buildNarratorPrompt(parsedInput), {
      structuredOutput: {
        schema: NarrativeOutput,
        errorStrategy: "strict",
        // Same reason as investigator.ts: `true` pastes the schema into the
        // system message and drops the provider's native `response_format`,
        // so the model free-forms the JSON and every miss costs a narrator
        // attempt — here it silently degrades to renderNarrativeTemplate.
        jsonPromptInjection: false,
      },
      modelSettings: {
        maxRetries: 0,
      },
    });
    const output = NarrativeOutput.parse(response.object);
    assertNarrativeUsesOnlyEvidenceNumbers(output.operations, parsedInput);
    assertNarrativeUsesOnlyEvidenceNumbers(output.executive, parsedInput);
    return output;
  };

  try {
    return await render(primary);
  } catch {
    try {
      return await render(secondary);
    } catch {
      const output = renderNarrativeTemplate(parsedInput);
      assertNarrativeUsesOnlyEvidenceNumbers(output.operations, parsedInput);
      assertNarrativeUsesOnlyEvidenceNumbers(output.executive, parsedInput);
      return output;
    }
  }
}
