import { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";
import { buildInvestigatorAgent } from "./agents/investigator.js";
import { buildNarratorAgent } from "./agents/narrator.js";
import { loadAgentConfig } from "./config.js";

let root: Mastra | undefined;

/**
 * The single Mastra root, built lazily on first use.
 *
 * Agents are registered once here instead of being constructed inside each
 * call, which is what gives tracing and Studio something to observe — the
 * reason ai_agent_module.md gave for choosing the framework.
 *
 * No `storage` (and so no `logger`) is wired here. Nothing in phase 1 reads
 * or writes Mastra storage — there is no workflow yet, nothing suspends,
 * nothing resumes — so a store here would be speculative infrastructure,
 * which AGENTS.md forbids. It also isn't free: constructing a real
 * `PostgresStore` runs schema DDL against the configured database on first
 * use, which broke `coordinator.test.ts` and `orchestrate/full-flow.e2e.test.ts`
 * when this was tried. Storage arrives in phase 4, next to the workflow that
 * actually needs it (suspending a run for the human decision), where the
 * test strategy can be designed around it. Do not "complete" this config by
 * adding storage or a logger back before then.
 *
 * Built lazily rather than at module scope: investigator.ts and narrator.ts
 * import from this module, and a top-level `new Mastra(...)` would run at
 * every agent unit test's import time just to import its subject.
 * agent.test.ts avoids calling this at all by injecting `agent:` mocks into
 * runInvestigation.
 */
export function getMastra(): Mastra {
  if (!root) {
    const config = loadAgentConfig();
    root = new Mastra({
      agents: {
        investigator: buildInvestigatorAgent(config.investigatorModel),
        narrator: buildNarratorAgent("narrator", config.narratorModel),
        "narrator-fallback": buildNarratorAgent("narrator-fallback", config.narratorFallbackModel),
      },
    });
  }
  return root;
}

export function getInvestigatorAgent(): Agent {
  return getMastra().getAgent("investigator");
}

export function getNarratorAgent(): Agent {
  return getMastra().getAgent("narrator");
}

export function getNarratorFallbackAgent(): Agent {
  return getMastra().getAgent("narrator-fallback");
}
