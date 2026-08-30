# An env kill switch for the deterministic fallback, default on

## Options considered

- **Delete `executeFallback`**, making the agent the only path to a diagnosis.
- **A flag defaulting to off**, keeping the code and the tests but shipping the
  agent-only behaviour.
- **A flag defaulting to on** (`AGENT_FALLBACK_ENABLED`), off only when an
  operator sets it.

## What we chose

`AgentConfig.fallbackEnabled`, read from `AGENT_FALLBACK_ENABLED`, defaulting to
true; anything other than the literal `"false"` keeps the fallback. With it off,
`coordinator.executeFallback` returns immediately: no `actor: "fallback"` run is
created, no beam search runs, no narrative is attached, and the failed agent run
is still recorded through `failRun` with its failure code. The coordinator emits
`onFallbackSkipped`, which `run.ts` turns into a warning.

## Why

`rules.md` §3 boundary #3 — every agentic path has a deterministic fallback — is
one of the three boundaries code review rejects a PR over, and `AGENTS.md` lists
"purely agentic behavior with no deterministic fallback" as a blocker. Deleting
the path, or shipping it off by default, contradicts the boundary in the
codebase itself. A default-on flag contradicts nothing: the deterministic path
is still what the system does, and the switch exists for an operator watching
the fallback itself misbehave mid-demo — the beam search looping, the narrator
burning a rate limit on runs nobody will read.

The incident does not disappear when the switch is off. `orchestrate/incidents.ts`
already wrote the row at tick time from deterministic evidence (that is the same
boundary #3, one layer down), so what is lost is the narrative and the enriched
evidence, not the detection.

**What the choice costs.** An operator can put the system into a state that
`rules.md` §3 forbids, and the only trace is one warning line per incident. We
accept it because the alternative — no switch — means the only way out of a
misbehaving fallback during the demo is a code change and a redeploy. The
`onFallbackSkipped` callback exists precisely so that state is loud rather than
a card that quietly never gets its story.

## Update — default flipped to off

`readFallbackEnabled` now returns true only for the literal `"true"`; unset means
off. The beam-search + narrator fallback is opt-in. Boundary #3 still holds one
layer down: `orchestrate/incidents.ts` writes the incident row from deterministic
evidence at tick time, so the detection never depends on the agent. What the
default-off state loses is the enriched evidence and the narrative on a failed
investigation, and `onFallbackSkipped` still logs a warning per incident so the
gap is visible.
