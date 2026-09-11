import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { NarrationInput } from "@control-tower/contracts";
import { EvidenceNumbersProcessor, NARRATION_INPUT_KEY } from "../processors/evidence-numbers.js";

export function buildNarratorAgent(
  id: "narrator" | "narrator-fallback",
  model: MastraModelConfig,
): Agent {
  return new Agent({
    id,
    name: id === "narrator" ? "Incident Narrator" : "Incident Narrator (reserve)",
    instructions:
      "You narrate a closed payment-incident evidence object. Never calculate new numbers and never add numbers that are not present in the evidence object or recommendation.",
    model,
    // Built per request rather than once: the evidence object it enforces
    // against travels on the RequestContext narrator.ts sets up for each
    // render() call, so the same registered agent enforces a different
    // evidence object on every request instead of one baked in at
    // construction time.
    outputProcessors: ({ requestContext }) => {
      const input = requestContext?.get(NARRATION_INPUT_KEY) as NarrationInput | undefined;
      return input ? [new EvidenceNumbersProcessor(input)] : [];
    },
  });
}
