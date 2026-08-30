# Build the AI agent module with Mastra and deterministic boundaries

## Options considered

### Agent framework

- **Mastra** — a TypeScript-native framework with typed tools, agents,
  workflows, observability, evaluations, memory primitives, and a local Studio.
- **OpenAI Agents SDK for TypeScript** — a provider-focused runtime with tools,
  structured outputs, guardrails, and tracing.
- **LangGraph.js** — a low-level graph runtime with durable execution,
  checkpoints, resumability, and human-in-the-loop primitives.
- **A hand-written ReAct loop** — direct model calls with custom tool dispatch,
  step limits, timeouts, retries, tracing, and audit persistence.

### Investigator tool surface

- Expose diagnostic internals such as `peeling`, `parsimony`, and
  `beam_search`, allowing the model to decide whether mandatory rules run.
- Expose one generic cube-query tool that accepts arbitrary dimensions and
  query parameters.
- Expose six narrow, typed, read-only tools over deterministic services.
- Use five analytical tools plus a `submit_diagnosis` termination tool.

### Memory and playbooks

- Store incident history, similarity search, playbooks, and approval state in
  Mastra memory and allow the investigator to update them.
- Give the investigator no state and no access to prior incidents.
- Separate transient agent state from domain-owned incident memory and
  operational playbooks.

## What we chose

We chose **Mastra** as the framework for the AI agent module. We will not use
the OpenAI Agents SDK, LangGraph.js, or a hand-written agent loop. Mastra will
orchestrate model calls and typed tool use, while all numerical and business
rules remain framework-agnostic and deterministic.

The investigator receives exactly six tools:

1. `query_conversion_slice` drills down by one valid dimension and returns
   aggregated conversion metrics, the expected rate, Wilson interval, and cell
   state.
2. `query_conversion_history` returns the authorized aggregated time series for
   a selected cell and time window.
3. `query_decline_mix` compares the current decline-code composition with its
   reference mix, including family and `diagnostic` metadata.
4. `run_residual_test` excludes a candidate cause and reports which correlated
   anomalies remain or disappear.
5. `scan_incident_onset` returns the calculated `started_at`, its exactness, and
   the aggregate windows that support it.
6. `estimate_incident_impact` returns deterministically calculated lost
   approvals, local cost, USD cost, cost per minute, and priority.

All tool inputs and outputs use closed schemas. Tools cannot accept SQL, table
names, arbitrary columns, raw transaction identifiers, or invalid routing
combinations. Every invocation is persisted in `investigation_steps` with its
actor, arguments, and result. The final diagnosis is structured agent output,
not a seventh tool.

`peeling`, `parsimony`, and `beam_search` remain internal deterministic
mechanisms. Conversion, expected rates, Wilson intervals, decline-code shares,
onset, cost, priority, fingerprints, lifecycle, and playbook matching are never
calculated or decided by the LLM. A failed, timed-out, or exhausted agent run
always falls back to the deterministic beam search.

Mastra owns only transient state for the current investigation: messages, tool
results, remaining step budget, stopping state, and any checkpoint needed to
resume that run. Runs are isolated by `incident_id` and cannot implicitly reuse
context from another incident.

Exact fingerprints, incident persistence, pgvector embeddings, similarity
ranking, lifecycle, and audit persistence remain owned by the orchestration and
data layers. The agent may consume a closed, read-only summary of similar
incidents through a typed adapter, but it cannot generate or mutate domain
memory.

Playbooks are versioned operational policy owned by Product and Operations. A
deterministic matcher selects one from `causal_dimension` and `decline_family`.
The narrator receives a closed evidence object and may explain the selected
action, but it cannot calculate, create a new action, or change the catalog.
Approval or rejection is persisted by the API and UI orchestration layer. The
system never executes remediation.

## Why

Mastra matches the existing TypeScript runtime and provides typed tool calling,
tracing, observability, evaluations, and a development Studio. These facilities
help the team inspect tool selection, stopping behavior, latency, and failure
paths before the live demonstration. Its workflow primitives also leave room
for resumability and human approval without requiring a later framework
migration, while multi-provider support avoids coupling the module to a single
model vendor.

The six narrow tools make each analytical question reproducible, auditable, and
unit-testable without an LLM. They keep transverse and temporal analysis
explicit, prevent raw transaction access, reject semantically invalid drill
downs such as issuer analysis for PIX, and ensure mandatory business rules do
not depend on model judgment.

Keeping domain memory and playbooks outside Mastra preserves a single auditable
source of truth for payment incidents. Exact fingerprint lookup and the
deterministic fallback continue working without the agent runtime. Human-owned,
versioned playbooks prevent the LLM from inventing operational policy and
preserve the rule that every recommendation requires human approval.

The decision has costs. Mastra adds a broader production dependency and a
larger conceptual surface than a provider-specific SDK or a small custom loop.
It introduces framework learning, integration, upgrade, and debugging risk
during a 24-hour build. Six narrow tools require more schemas and adapters than
a generic query endpoint, and separating agent state from domain memory creates
explicit interfaces across the agent, orchestration, data, Product, and
Operations fronts.

We accept those costs because the team is standardizing on Mastra and values
its TypeScript developer experience, observability, evaluation tooling,
provider flexibility, and growth path. We contain the risk by keeping Mastra
behind narrow adapters, disabling framework-owned cross-incident memory,
preserving `investigation_steps` as the domain audit trail, and retaining the
beam search as the mandatory deterministic fallback. For the 24-hour scope,
exact fingerprint matching and four versioned playbooks come first; vector
similarity remains a cuttable extension.
