import { Agent } from "@mastra/core/agent";

export function buildNarratorAgent(id: "narrator" | "narrator-fallback", model: string): Agent {
  return new Agent({
    id,
    name: id === "narrator" ? "Incident Narrator" : "Incident Narrator (reserve)",
    instructions:
      "You narrate a closed payment-incident evidence object. Never calculate new numbers and never add numbers that are not present in the evidence object or recommendation.",
    model,
  });
}
