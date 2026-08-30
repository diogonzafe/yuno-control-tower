---
title: "The Control Tower — Instructions for agents"
doc_id: "YCT-AGENTS-001"
doc_related:
  - "YCT-RULES-001"
  - "context/spec.md"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/README.md"
domain: "engineering-governance"
dimension_schema: []
time: "2026-08-30T05:00:00Z"
---

# AGENTS.md

## Project mission

Build **The Control Tower**, a payment operations system that detects
material conversion drops, diagnoses the root cause across transaction
dimensions, explains the evidence and the estimated cost, and recommends a
human action. The system never executes remediation.

The *trial by fire* is a product constraint: detection and diagnosis must be
generic. Never hardcode rehearsed incident combinations.

## Read before changing code

Read the relevant files in `context/` before planning or implementing:

1. `context/spec.md` — product problem, vocabulary, and acceptance criteria.
2. `context/schema.md` — locked decisions DD1-DD11, data contracts, and DDL.
3. `context/roadmap.md` — architecture, phases, and delivery priorities.
4. `context/rules.md` — engineering rules, TDD, and the review checklist.

Use the domain vocabulary from those documents. Do not invent synonyms for
established concepts such as `expected_conversion`, `decline_family`, and
`residual_test`.

Explicit decisions DD1-DD11 override older briefing examples in case of
conflict. Do not silently resolve an open question P1-P4. Ask the user and
record the outcome in the decision log before implementing work that depends
on it.

DD11 is resolved: the detector's test is the **Wilson interval** (closed-form
formula, `z = 1.96`, 3-window persistence). `context/schema.md` §6.3 is the
normative reference; the decision record is at
`flight_logs/wilson_detection.md`. The detector's spec is `context/detector.md`
(`YCT-DETECT-001`).

## Non-negotiable architectural boundaries

Keep these three concerns separate:

- Numbers are deterministic: ingestion, rollups, detection, residual analysis,
  onset scan, cost, and priority are all computed without an LLM.
- Judgment can be agentic: the investigator chooses which aggregated slice to
  inspect next, bounded by tools, steps, and a timeout.
- Text belongs to the LLM: the narrator verbalizes a closed evidence object
  and never calculates or introduces a number absent from that object.

Therefore:

- Never expose raw `transactions` rows to the investigator. Agent tools return
  only metrics from `rollup_minute` or `rollup_declines_minute`.
- Every agentic diagnosis path must have the deterministic beam search as a
  fallback.
- `EvidenceObject` is assembled by `diagnose/evidence.ts`, deterministically,
  never by the agent — the fallback must produce the same object without an
  LLM. The agent only contributes the optional trail; `orchestrate/` persists
  the finished object. See `flight_logs/who_assembles_the_evidence_object.md`.
- Recommendations require human approval and are never executed by the
  system.
- Preserve `investigation_steps` as an auditable record of every question,
  argument, result, and actor.

## Data and diagnosis invariants

- One request equals one synchronous attempt; statuses are `SUCCESS` and
  `DECLINED`. Do not add retry or `PENDING`.
- Locked countries are AR, MX, and BR; providers are Stripe, Adyen, and
  Mercado Pago; methods are card and PIX; PIX exists only in BR.
- Treat `account_id` and `merchant_id` as the same entity and keep only
  `merchant_id`.
- Compare `merchants.expected_conversion` only against the merchant's
  aggregate, never directly against a cell.
- Conversion cells use five dimensions. `decline_code` is not a conversion
  dimension: it describes the composition of failures in the separate decline
  rollup.
- Evaluate only valid provider-country-method combinations declared in the
  coverage matrix. Never interpret a non-existent cell as zero traffic.
- Store local amount, USD amount, exchange rate, quote date, and quote source
  on the transaction. Never recompute historical USD with a newer rate.
- Use UTC in storage and convert time zones only for display.
- Diagnose the root cause, not correlated shadows. Use the residual test to
  suppress echoes and reveal simultaneous incidents.
- Low-volume slices produce `INSUFFICIENT_EVIDENCE`; never force them into the
  healthy or anomalous states.

## Engineering flow

- Follow red-green-refactor. Write the failing test before the production
  code.
- Make the smallest change that satisfies the requested behavior and the
  current roadmap phase. Do not implement speculative infrastructure or YAGNI
  items rejected in `context/rules.md`.
- Reuse a single parameterized aggregation implementation for slice queries,
  residual tests, and retroactive scans. Do not duplicate conversion logic.
- Keep deterministic, agentic, and narration code in separate modules.
- Code, identifiers, file names, database objects, branches, commits, and
  error messages stay in English. Context documents (`context/`) may stay in
  Portuguese.
- Comments explain non-obvious reasons and cite decisions such as DD8 or
  DD11; they do not narrate what the code evidently does.
- Do not add a production dependency without explaining why the existing
  stack is insufficient and getting the user's approval.
- Never read, print, alter, or version values from `.env`, except when the
  task explicitly requires a specific environment change. Use `.env.example`
  only with fictitious values to document configuration.
- Preserve unrelated changes made by the user. Do not rewrite or clean up
  files outside the requested scope.

## Markdown documentation governance

Every `.md` file created in the repository must start with YAML front matter,
before any title or content, delimited by `---` and containing exactly these
required fields (exception: files under `flight_logs/` — see the *Flight
logs* section):

```yaml
---
title: "Specific, human-readable title"
doc_id: "YCT-AREA-001"
doc_related: []
domain: "domain-slug"
dimension_schema: []
time: "2026-08-29T22:47:03Z"
---
```

Field rules:

- `title`: readable, specific title consistent with the document's first `#`.
- `doc_id`: stable, repository-unique identifier in the format
  `YCT-<AREA>-<NNN>`. Never rename or reuse an existing ID.
- `doc_related`: YAML list of related `doc_id`s. For a legacy document without
  a `doc_id`, temporarily accept the repo-relative path. Use `[]` when there
  is no relation.
- `domain`: English slug for the document's primary domain.
- `dimension_schema`: YAML list containing only the canonical dimensions
  affected: `merchant`, `provider`, `country`, `payment_method`, `issuer`,
  and `decline_code`. Use `[]` for cross-cutting documentation or anything
  unrelated to the cube.
- `time`: date and time of the last substantive change, in UTC and RFC 3339
  (`YYYY-MM-DDTHH:mm:ssZ`). Update it when content or decisions change; do
  not update it for formatting-only changes.

Do not create a Markdown file with a missing field, a duplicate key, an
already-used `doc_id`, or a local time without an offset. Before finishing a
task that creates documentation, validate the front matter and search the
repository for the `doc_id` to confirm uniqueness.

## Flight logs — recording important decisions

Every **important** decision becomes a file in `flight_logs/`, written at the
moment the decision is made — never reconstructed at the end. It is the
*decision log* required by the briefing (`context/spec.md` §6) and the
ammunition for the technical defense: the ready answer to "why didn't you do
it another way."

A decision counts as important and **requires** a flight log when it:

- locks a new `DD` or supersedes an existing `DD`;
- resolves an open question `P1`-`P4`;
- fixes a public data contract, an architectural boundary, the stack, or a
  production dependency;
- discards an alternative a judge would likely raise during Q&A;
- adopts a conscious simplification that departs from real domain behavior
  (e.g., PIX treated as synchronous).

It **does not** require a flight log:

- a refactor, rename, or local, reversible implementation choice;
- a detail already covered by a test with no relevant alternative at stake;
- a change that is only formatting, a comment, or documentation text.

When in doubt between the two cases, ask the user before deciding alone.

Format: one file per decision, name in `snake_case`, content in English.
These are plain markdown, **without** the YAML front matter required of other
`.md` files — they get published on the hackathon platform with just the four
sections, in this order: **title** (the decision in one line), **options
considered**, **what we chose**, and **why** — and the "why" includes what
the choice costs, not only the benefit. When creating the file, add the
corresponding line to the index in `flight_logs/README.md`; if the decision
also locks a `DD` or closes a `P`, update `context/schema.md` in the same
step — the two must not diverge.

## Testing expectations

Find the exact commands in the repository's manifests and tooling
configuration; do not invent commands while the project is still being
built.

By default, tests must be deterministic:

- Rollups: exact aggregates from fixed batches of events.
- Detection: fixed tables covering probability thresholds, volume, material
  drop, and three-window persistence.
- Residual analysis: hand-computed fixtures with one cause and multiple
  echoes.
- Diagnosis: mandatory scenario of a simultaneous provider incident in BR and
  issuer incident in MX over seeded rollups.
- Agent tools: deterministic input/output tests with a mocked LLM.
- Narrator: reject any number in the output that is not in the evidence
  object.
- End-to-end tests with an LLM: run separately, only after deterministic
  coverage, using a real or recorded response instead of layered mocks for
  business rules.

After a change, run the narrowest relevant tests first; then the full suite,
lint, type-check, and build defined by the project. Report any check that
could not be run and why.

## Definition of done

Before handing back work:

- Verify the requested acceptance behavior, including failure or
  insufficient evidence where relevant.
- Confirm that none of the three architectural boundaries was crossed.
- Confirm that no DD1-DD11 was contradicted and no P1-P4 was assumed.
- Update context, README, architecture diagram, or the decision log in
  `flight_logs/` when a public contract or an architectural choice changes;
  every important decision has its flight log before the work is handed
  back.
- Summarize files changed, checks run, and any risks or decisions still
  open. Never say a test passed without having run it.

## Code review rules

Flag as a blocker:

- Hardcoding a scenario that could fail under the *trial by fire*.
- Raw transaction access by an agent tool.
- Arithmetic or fabricated numbers in narration code.
- Purely agentic behavior with no deterministic fallback.
- The merchant's expected conversion applied directly to a lower-level cell.
- Missing residual analysis when selecting or separating root causes.
- A non-existent routing cell treated as a zero-volume observation.
- Historical USD values recomputed with the current exchange rate.
- A business rule covered only by an LLM-dependent test.
- An undocumented contradiction of DD1-DD11 or an assumption about P1-P4.
- An important decision made without the corresponding flight log in
  `flight_logs/`.
