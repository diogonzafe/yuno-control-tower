# Record auditable decision summaries, not chain-of-thought

## Options considered

- Ask the investigator to write out all its reasoning in `<thinking>` tags
  and persist that text in the database.
- Use, where available, the reasoning summary provided by the model
  provider as the product's official trail.
- Require a short, structured decision context on every tool call,
  referenced to prior steps, keeping internal reasoning out of the database.
- Record only the tools' arguments and results, without explaining why the
  agent chose each next query.

## What we chose

Every investigator tool call carries a validated `decisionContext` with:

- `tag`, chosen from a closed enumeration of the investigative step;
- `summary`, at most 500 characters and based only on visible evidence;
- `hypothesis`, optional and structured as a dimension and an investigated
  value;
- `basedOnStepNos`, containing only already-completed steps from the same
  run.

The tool wrapper strips `decisionContext` before calling the deterministic
service. The audit trail persists the context in dedicated
`investigation_steps` columns; the dashboard renders `tag` as a visual marker
and shows the summary alongside the tool's arguments and results.

The initial tags are `HYPOTHESIS`, `DRILL_DOWN`, `COMPARE_HISTORY`,
`CHECK_DECLINE_MIX`, `VALIDATE_RESIDUAL`, `CONFIRM_ONSET`, and
`ESTIMATE_IMPACT`. The structured conclusion uses `STOP_CONCLUSIVE` or
`STOP_INCONCLUSIVE` and references the steps that support it. Call-level
context lives in `investigation_steps`; the conclusion's tag, summary, and
supporting steps live in `investigation_runs`. The conclusion is not modeled
as a seventh tool.

We do not request or persist chain-of-thought, `<thinking>`-tag content,
reasoning tokens, or hidden provider text. A reasoning summary the provider
happens to expose may serve technical observability, but it never replaces
the domain trail and never participates in diagnosis.

## Why

The dashboard needs to explain the investigator's sequence of decisions, but
free-form reasoning text is not a stable, verifiable, or safe contract. A
structured context lets us validate length, vocabulary, references, and the
absence of unobserved numbers, while also tying each justification to the
question and result that were actually audited.

Separating `decisionContext` from the deterministic input preserves the
project's boundary: the agent chooses what to query, while numbers and rules
stay in the deterministic services. It also avoids treating model-generated
XML or HTML as the dashboard's interface.

The cost is a larger schema across the six tools, the migration, the tests,
and the prompt. The summary is still an explanation produced by the model,
not proof of causality by itself; the proof remains in the tools' results and
the referenced steps. The tag enumeration will also need versioning if the
investigation flow gains new stages.
