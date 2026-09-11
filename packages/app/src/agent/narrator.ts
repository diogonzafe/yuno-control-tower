import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import {
  NarrativeOutput,
  NarrationInput,
  type NarrativeOutput as NarrativeOutputType,
  type NarrationInput as NarrationInputType,
} from "@control-tower/contracts";
import type { AgentConfig } from "./config.js";
import { getNarratorAgent, getNarratorFallbackAgent } from "./mastra.js";
import {
  assertNarrativeUsesOnlyEvidenceNumbers,
  NARRATION_INPUT_KEY,
} from "./processors/evidence-numbers.js";

// narrator.test.ts imports this symbol from here; the implementation moved to
// processors/evidence-numbers.ts so EvidenceNumbersProcessor can depend on it
// without narrator.ts -> mastra.ts -> agents/narrator.ts -> that module ->
// narrator.ts becoming a cycle.
export { assertNarrativeUsesOnlyEvidenceNumbers };

export function buildNarratorPrompt(input: NarrationInputType): string {
  return [
    "Write two short narratives from the closed evidence object and optional recommendation.",
    "The first is for operations. The second is for executives.",
    "Do not invent any number, percentage, duration, count, date, or currency amount.",
    JSON.stringify(input),
  ].join("\n");
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
    // Carries this request's evidence object to EvidenceNumbersProcessor,
    // which agents/narrator.ts wires as a dynamic outputProcessor reading
    // this same key back off the RequestContext it receives.
    const requestContext = new RequestContext();
    requestContext.set(NARRATION_INPUT_KEY, parsedInput);

    const response = await runner.generate(buildNarratorPrompt(parsedInput), {
      requestContext,
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

    // Measured against the installed @mastra/core@1.37.1: EvidenceNumbers-
    // Processor's abort() call does NOT reject this generate() call — it
    // resolves normally with `tripwire` set and `object`/`text` still
    // carrying the violating narrative (a fabricated number came back
    // intact in the probe that established this). Without this check,
    // NarrativeOutput.parse below would happily return the fabricated
    // narrative as valid and the primary -> reserve -> template cascade
    // would never fire. Throwing here is what puts the tripwire back on the
    // cascade's existing try/catch.
    if (response.tripwire) {
      throw new Error(response.tripwire.reason);
    }

    return NarrativeOutput.parse(response.object);
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
