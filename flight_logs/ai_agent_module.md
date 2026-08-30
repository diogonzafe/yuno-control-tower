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

### Investigation continuity and audit

- Persist Mastra memory across incidents so the investigator can reuse earlier
  messages, tool results, working memory, or semantic recall automatically.
- Persist workflow snapshots and resume an interrupted investigator from its
  last model step.
- Treat every attempt to diagnose an incident as an isolated run, fall back
  deterministically when that run fails, and keep a domain-owned audit trail of
  runs and tool steps.

### Historical incident matching

- Make vector similarity the primary memory path and embed free-form agent
  narratives.
- Use one canonical exact fingerprint as the current delivery and defer vector
  similarity until its embedding model, input contract, and evaluation harness
  are defined.
- Include absolute timestamps and financial impact in the incident identity.
- Put local time and day type directly in the causal fingerprint or future
  embedding so that incidents from different operating periods become different
  memories.
- Keep temporal context out of causal identity and use it only as structured
  metadata for deterministic filtering or reranking if vector search is added.

### Provisional evidence contract

- Block agent-module development until the detector and its deterministic
  orchestrator publish their final evidence contract.
- Couple the agent module directly to the detector-orchestrator's internal
  object shape.
- Document a small provisional object and mock that can later be replaced by an
  adapter without changing the narrator or its tests.

### Model provider integration

- Call the OpenAI API through the OpenAI SDK directly from the agent module.
- Use the existing OpenAI API key through Mastra model routing and keep provider
  and model identifiers configurable.

## What we chose

We chose **Mastra** as the framework for the AI agent module. We will not use
the OpenAI Agents SDK, LangGraph.js, or a hand-written agent loop. Mastra will
orchestrate model calls and typed tool use, while all numerical and business
rules remain framework-agnostic and deterministic.

The live provider is OpenAI, authenticated with `OPENAI_API_KEY`, but all model
calls go through Mastra model routing. The agent module does not import or use
the OpenAI SDK directly. `INVESTIGATOR_MODEL`, `NARRATOR_MODEL`, and
`NARRATOR_FALLBACK_MODEL` remain configuration values so exact model IDs can be
confirmed when implementation begins.

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

A `CONCLUSIVE` diagnosis is accepted only when its structured output references
a root cause, a completed residual test, onset evidence returned by
`scan_incident_onset`, impact evidence returned by
`estimate_incident_impact`, and the supporting audit steps. Missing required
evidence makes the agent run invalid and hands control to the fallback. Timeout,
model error, and exhausted step budget are run failures, not inconclusive
diagnoses.

`peeling`, `parsimony`, and `beam_search` remain internal deterministic
mechanisms. Conversion, expected rates, Wilson intervals, decline-code shares,
onset, cost, priority, fingerprints, lifecycle, and playbook matching are never
calculated or decided by the LLM. A failed, timed-out, or exhausted agent run
always falls back to the deterministic beam search.

Mastra owns only transient state for the current investigation: messages, tool
results, remaining step budget, and stopping state. Persistent working memory,
semantic recall, and observational memory are disabled for the investigator.
Each attempt is isolated by `incident_id` and `run_id` and cannot implicitly
reuse context from another incident.

For the 24-hour delivery, an interrupted, failed, timed-out, or exhausted agent
run is not resumed from a Mastra snapshot. The run is closed with its terminal
status. The upstream deterministic incident orchestrator receives the typed
failure and starts a new beam-search fallback run. The Mastra investigator never
calls the fallback directly. A later manual retry also creates a new `run_id`;
it never overwrites an earlier attempt. Durable Mastra workflow snapshots remain
a future option for genuinely long-running work.

The investigator budget is at most 12 tool executions and 45 seconds of total
wall-clock time. Each tool invocation counts once, including parallel calls.
Model-only turns do not consume the tool budget. The 24-hour delivery performs
no internal model retry: provider errors immediately return a typed run failure
to the deterministic incident orchestrator.

Audit persistence is split into `investigation_runs` and
`investigation_steps`. A run records its actor, status, model and prompt version
when applicable, timestamps, and failure code. A step belongs to one run and
records an idempotent tool-call identifier, sequence number, typed arguments,
result or error, timestamps, and a concise `decision_summary`. The summary is
an auditable explanation based on visible evidence; hidden chain-of-thought is
never requested or stored.

Exact fingerprints, incident persistence, historical lookup, lifecycle, and
audit persistence remain owned by the orchestration and data layers. The exact
fingerprint is the only historical-matching path in the current delivery.
pgvector similarity is deferred until the team defines and evaluates a
versioned embedding contract; no HNSW index is part of this delivery. The agent
may consume up to three closed, read-only summaries of resolved matching
incidents as call-time context, but it cannot generate or mutate domain memory.

The versioned fingerprint is canonical and deterministic: fixed dimension keys
are serialized in a fixed order, absent values are explicit, and the dominant
decline code is included. It represents causal identity, so it excludes cost,
conversion rate, priority, narrative text, and absolute timestamps. Open
incidents use it for deduplication; resolved incidents use it for historical
recognition. Inconclusive incidents are not presented as precedent.

DD7 remains authoritative for the current delivery: healthy conversion is
stationary and only traffic volume is seasonal. Time of day, day type, and
merchant operating schedules therefore do not alter the exact fingerprint or
the detector. No traffic produces no observed cell, and low volume remains
`INSUFFICIENT_EVIDENCE` under the deterministic statistical rules.

If vector similarity is implemented later, its versioned embedding input will
represent the canonical causal fields, not absolute timestamps, cost, current
conversion, priority, narratives, agent reasoning, or recommendation text.
Local hour bucket, day type, and an explicit operating-calendar state may be
carried as structured metadata for deterministic filtering or reranking; they
are not inferred by the LLM and are not trusted to embedding distance. Adding a
time-varying healthy conversion rate would require a separate decision that
revisits DD7 and the detector, not a change to agent memory.

Mastra runtime data and observability traces may use the same PostgreSQL
instance as the product, but they remain in framework-owned storage structures
and are never the source of truth for incidents or audit. Cross-incident memory
features stay disabled. Traces use sensitive-data redaction and a seven-day
retention window for the hackathon environment; domain incidents and audit rows
are outside that pruning policy.

The detector and its deterministic incident orchestrator are owned by another
development front. That orchestrator is not an agent and must not be confused
with the Mastra runtime. The provisional integration uses three lifecycle
contracts so the investigator does not receive fields that only exist after it
runs:

```ts
type DecimalString = string;
type IncidentStatus = "open" | "monitoring" | "resolved" | "inconclusive";
type EvidenceState =
  | "HEALTHY"
  | "ANOMALOUS"
  | "INSUFFICIENT_EVIDENCE";

type InvestigationRequestV0 = {
  schemaVersion: "0";
  source: "mock" | "detector_orchestrator";
  incident: {
    incidentId: string;
    fingerprint: string;
    status: IncidentStatus;
    detectedAt: string;
  };
  trigger: {
    merchantId: string;
    country: "AR" | "MX" | "BR";
    attempts: number;
    approved: number;
    expectedRate: DecimalString;
    currentRate: DecimalString;
    ciLow: DecimalString;
    ciHigh: DecimalString;
    ciLevel: DecimalString;
    persistenceWindows: number;
  };
  similarIncidents: Array<{
    incidentId: string;
    fingerprint: string;
    resolvedAt: string;
  }>;
};

type DiagnosisResultV0 =
  | {
      conclusion: "CONCLUSIVE";
      causalDimension:
        | "merchant"
        | "provider"
        | "payment_method"
        | "issuer";
      dimensions: {
        merchantId: string;
        providerId: string | null;
        country: "AR" | "MX" | "BR" | null;
        paymentMethod: "CARD" | "PIX" | null;
        issuerId: string | null;
      };
      dominantDecline: {
        code: string;
        family: string;
        currentShare: DecimalString;
        referenceShare: DecimalString;
      } | null;
      evidence: {
        residualStepNo: number;
        onsetStepNo: number;
        impactStepNo: number;
        supportingStepNumbers: number[];
      };
    }
  | {
      conclusion: "INCONCLUSIVE";
      reason: "INSUFFICIENT_EVIDENCE" | "CONFLICTING_EVIDENCE";
      missingEvidence: string[];
      supportingStepNumbers: number[];
    };

type AgentRunResultV0 =
  | { status: "COMPLETED"; diagnosis: DiagnosisResultV0 }
  | {
      status: "FAILED";
      reason: "TIMEOUT" | "STEP_BUDGET_EXHAUSTED" | "MODEL_ERROR";
    };

type ProvisionalEvidenceObjectV0 = InvestigationRequestV0 & {
  diagnosis: DiagnosisResultV0;
  onset: {
    startedAt: string;
    startedAtExact: boolean;
  };
  impact: {
    lostApprovals: number;
    costLocalMinor: Partial<Record<"ARS" | "MXN" | "BRL", number>>;
    costUsdMinor: number;
    costUsdPerMinute: number;
    priorityScore: DecimalString;
  };
  recommendation: {
    playbookId: string;
    title: string;
    action: string;
  } | null;
  repetitions: Array<{
    matchedIncidentId: string;
    matchedBy: "exact_fingerprint";
    resolvedAt: string;
  }>;
  audit: {
    investigationRunId: string;
    diagnosisActor: "agent" | "fallback";
    evidenceStepNumbers: number[];
    generatedAt: string;
  };
};
```

The provisional investigator request mock is:

```ts
const investigationRequestMock: InvestigationRequestV0 = {
  schemaVersion: "0",
  source: "mock",
  incident: {
    incidentId: "00000000-0000-4000-8000-000000000001",
    fingerprint: "fingerprint:v1:merchant=merchant_demo;country=BR",
    status: "open",
    detectedAt: "2026-08-30T14:06:00Z",
  },
  trigger: {
    merchantId: "merchant_demo",
    country: "BR",
    attempts: 420,
    approved: 176,
    expectedRate: "0.66000",
    currentRate: "0.41905",
    ciLow: "0.37278",
    ciHigh: "0.46676",
    ciLevel: "0.950",
    persistenceWindows: 3,
  },
  similarIncidents: [],
};
```

The provisional final evidence mock for narrator tests is:

```ts
const provisionalEvidenceMock: ProvisionalEvidenceObjectV0 = {
  ...investigationRequestMock,
  diagnosis: {
    conclusion: "CONCLUSIVE",
    causalDimension: "issuer",
    dimensions: {
      merchantId: "merchant_demo",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    },
    dominantDecline: {
      code: "DO_NOT_HONOR",
      family: "issuer",
      currentShare: "0.78000",
      referenceShare: "0.32000",
    },
    evidence: {
      residualStepNo: 4,
      onsetStepNo: 5,
      impactStepNo: 6,
      supportingStepNumbers: [1, 2, 3, 4, 5, 6],
    },
  },
  onset: {
    startedAt: "2026-08-30T14:03:00Z",
    startedAtExact: true,
  },
  impact: {
    lostApprovals: 101,
    costLocalMinor: { BRL: 12840000 },
    costUsdMinor: 2568000,
    costUsdPerMinute: 856000,
    priorityScore: "8560.0000",
  },
  recommendation: {
    playbookId: "issuer_over_declining_v1",
    title: "Escalate issuer over-declining",
    action: "Request issuer review and keep human approval pending.",
  },
  repetitions: [],
  audit: {
    investigationRunId: "00000000-0000-4000-8000-000000000002",
    diagnosisActor: "agent",
    evidenceStepNumbers: [1, 2, 3, 4, 5, 6],
    generatedAt: "2026-08-30T14:06:30Z",
  },
};
```

`schemaVersion: "0"` explicitly marks all three contracts as provisional. The
deterministic incident orchestrator sends `InvestigationRequestV0`, the Mastra
investigator returns `AgentRunResultV0`, and the deterministic incident
orchestrator composes `ProvisionalEvidenceObjectV0` for the narrator after the
agent or fallback finishes. When the upstream contract is confirmed, adapters
replace these provisional boundaries without changing the agent's decision
rules or the narrator's behavior tests.

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

The three provisional lifecycle contracts let the agent module and narrator
progress without inventing ownership of the detector-orchestrator contract. The
cost is temporary duplication and expected adapter changes when the real
objects arrive. Version `0`, runtime validation, and explicit replacement
boundaries make that cost visible and prevent the mock shapes from silently
becoming permanent production contracts.

Using the OpenAI API through Mastra keeps the chosen framework responsible for
model routing, tool calling, and provider integration while avoiding a second,
direct SDK path. The API key remains external configuration and is never stored
in repository files. Configurable model IDs add setup work but let the team
confirm availability at implementation time without changing agent code.

Separating incidents, runs, and steps avoids ambiguous retries. One real-world
incident can have a failed agent attempt, a successful fallback attempt, and a
later manual retry without step-number collisions or overwritten evidence. The
extra run table and identifiers add schema and query complexity, but make the
failure path, model version, latency, and final source of the diagnosis
defensible.

Keeping temporal context outside causal identity prevents the same provider or
issuer failure from fragmenting into unrelated memories merely because it
happened at a different hour. Structured temporal metadata remains available
for a future retrieval layer when operational context matters. The accepted
cost is the DD7 limitation: a merchant whose healthy conversion genuinely
changes by hour is outside the current model and would require a time-aware
expected-conversion decision.

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
preserving `investigation_runs` and `investigation_steps` as the domain audit
trail, and retaining the beam search as the mandatory deterministic fallback.
For the 24-hour scope, exact fingerprint matching and four versioned playbooks
come first; vector similarity is explicitly deferred.
