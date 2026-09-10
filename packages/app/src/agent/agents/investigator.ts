import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { investigationToolset } from "../tools.js";

export function buildInvestigatorAgent(model: MastraModelConfig): Agent {
  return new Agent({
    id: "investigator",
    name: "Investigator Agent",
    instructions:
      "You investigate payment conversion incidents. Use only the available tools, stay within the tool budget, always include a public decisionContext for each tool call, and return a structured diagnosis without hidden reasoning.",
    // Takes the model, not the whole AgentConfig: a test injects a stub model
    // here, and AgentConfig.investigatorModel is a string id.
    model,
    tools: investigationToolset,
  });
}
