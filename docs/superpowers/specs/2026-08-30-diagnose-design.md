---
title: "The Control Tower — Root-cause diagnosis engine"
doc_id: "YCT-DIAG-001"
doc_related:
  - "YCT-DETECT-001"
  - "YCT-RULES-001"
  - "YCT-AGENTS-001"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/diagnosis_by_deficit_density.md"
  - "flight_logs/decline_mix_catalogue_reference.md"
  - "flight_logs/priority_by_conservative_cost.md"
domain: "diagnosis-engine"
dimension_schema:
  - "merchant"
  - "provider"
  - "country"
  - "payment_method"
  - "issuer"
  - "decline_code"
time: "2026-08-30T06:40:00Z"
---

# The Control Tower — Root-cause diagnosis engine

Track F2 (`context/roadmap.md` §5, H+7→H+13 window), scoped to a branch:
**deterministic diagnosis only, no database and no agentic layer.** Consumes
what `runDetectionTick` produces and returns diagnosed, prioritized
incidents.

---

## 1. Scope

### 1.1 In

- `packages/app/src/diagnose/`: residual test, beam search, parsimony,
  peeling, decline-mix shift, cost, and priority.
- `runDiagnosis`, which composes all of the above for a 1-minute bucket.
- Extending `RollupRow` with `amountMinorSum`, without which there is no
  local cost.

### 1.2 Out

| Item | Where it lives |
|---|---|
| Cube SQL, `RollupSource` implementation | SQL-layer branch |
| Writing to `incidents`, fingerprint, lifecycle, memory / pgvector | `orchestrate/` |
| Evidence object, handoff contract, the 6 tools, Mastra, narrator | `agent/` |
| Playbook matching and human approval | playbooks branch |
| Scheduler, API, SSE | API branch |

### 1.3 Inherited premise

The detector emits depth-0 and depth-1 signals, and per gap G1 in
`context/detector.md`, many of them are echoes of the same problem. Diagnosis
**does not trust these signals as candidates**: it only uses the merchant ×
country roots they name and re-derives everything from the rollup. That is
what keeps the search generic over the cube, a requirement of the trial by
fire, and what makes beam search an honest fallback for the third boundary
in `context/rules.md` §3.

---

## 2. Module layout

```
packages/app/src/diagnose/
├── constants.ts     # BEAM_WIDTH, MAX_DEPTH, SELECTION_TOLERANCE,
│                    #   MAX_INCIDENTS_PER_ROOT, MIN_DECLINES,
│                    #   DECLINE_WINDOWS_MIN, TEMPORAL_MIN_DECLINES,
│                    #   CURRENCY_BY_COUNTRY
├── types.ts         # DeclineRollupRow, DeclineCode, DeclineFamily
├── residual.ts      # residualDeficit()  — the single primitive
├── beam-search.ts   # beamSearch() + cellKey()  — depth <= 3 (DD19)
├── parsimony.ts     # selectCausal()  — density, magnitude, parsimony
├── peeling.ts       # peel()  — outer loop (DD18) + echo suppression
├── decline-mix.ts   # declineMixShift() + disambiguateOutage()
├── cost.ts          # estimateImpact()  — conservative edge (DD11)
├── fixtures.ts      # hand-computed scenarios
└── run.ts           # runDiagnosis()  — the top-level function
```

---

## 3. The primitive and its three consumers

`residualDeficit(rows, filter, expected, deltaPp, excluded)` re-reads a slice
with a set of cells carved out, returning the aggregate, the Wilson interval,
the state, and the deficit in lost approvals. It reuses `aggregate` and
`evaluate` from `detect/`; the `approved / attempts` logic is not rewritten
(`context/rules.md` §1).

| Consumer | Use |
|---|---|
| `beamSearch` | scores each candidate by the root's deficit that disappears when it is excluded |
| `peel` | stop condition: the root's residual is no longer material |
| echo suppression | tests the remaining candidates with the cause carved out |

The residual test is not a late step: it is the scoring function. An echo
node has an explained deficit near zero as soon as the real cause is removed
from the count.

---

## 4. Algorithm

### 4.1 Search

Fixed root of merchant × country (DD17). Free dimensions: provider, method,
issuer. Each child's expected value is the **cross-sectional cut against its
siblings** (`crossSectionalExpected`), never the merchant constant — the rule
from `context/schema.md` §6. Routing coverage is respected, and the issuer is
only split once the slice no longer carries PIX traffic, because PIX rows
carry issuer `NA`.

A candidate is admissible when it has a material drop by the Wilson interval
and excluding it strictly reduces the root's deficit. There is no explained-
fraction threshold: the residual is what ends the search.

### 4.2 Selection

Density first, then magnitude, then parsimony last. The rationale and the
discarded alternatives are in
`flight_logs/diagnosis_by_deficit_density.md`.

### 4.3 Peeling

Each round: search over the still-unexplained deficit, pick the cause,
record the suppressed echoes, and add the cell to the exclusion set. Stops
when the residual is no longer material (DD18).

### 4.4 Decline mix

Per-code share shift against `decline_codes.baseline_share`, with the cell's
own mix taking over once it has enough history. The window widens from 1 to
5 and 15 minutes until enough declines accumulate to read. `91` and `AB03`
are disambiguated by dispersion. See
`flight_logs/decline_mix_catalogue_reference.md`.

### 4.5 Cost and priority

Accumulated from `started_at` — retroactive scan reused from
`detect/onset-scan.ts` (DD8) — up to the detection window. Lost approvals
using `ci_high`, cost in USD and in local currency, and `priority_score`
equal to the cost per minute. See
`flight_logs/priority_by_conservative_cost.md`.

### 4.6 Insufficient evidence

A materially dropped root with no child standing out from its siblings
produces a diagnosis with `confidence: "INCONCLUSIVE"` on the root itself,
instead of promoting the least-innocent cell. This is the bonus from
`context/spec.md` §5, and it's what happens under a global, simultaneous
degradation — the case the absolute trigger exists to catch.

---

## 5. Tests

All deterministic, with hand-computed fixtures (`context/rules.md` §4).
21 tests across 7 files.

| File | Covers |
|---|---|
| `residual.test.ts` | one cause plus echoes: the residual clears for the echoes, not the cause |
| `beam-search.test.ts` | causal cell at depth 3; PIX semantic guard; healthy root |
| `parsimony.test.ts` | density beats dilution; structural PIX tie implies BR; Mexican issuer |
| `peeling.test.ts` | two simultaneous incidents under the same root; stop condition; suppressed echo |
| `decline-mix.test.ts` | `05` from 32% to 78%; PIX widening; temporal reference; the three readings of `91` |
| `cost.test.ts` | conservative edge, not the observed rate; accumulated and per-minute |
| `run.test.ts` | both mandatory scenarios together, ordered by money; insufficient evidence |

---

## 6. Decisions and known gaps

Recorded here so they aren't discovered during Q&A.

| # | Gap | Consequence / mitigation |
|---|---|---|
| D1 | No database: `diagnose/` is pure over arrays | Same cut as the detector. The SQL-layer branch implements `RollupSource` and feeds `runDiagnosis`. |
| D2 | No evidence object or handoff contract | Deferred by the user's decision. `Diagnosis` lives in `diagnose/run.ts`, not in `contracts`. Promoting it is the first step of the agent branch. |
| D3 | A cell reachable by two paths keeps the first expected reading | The cross-sectional expected value depends on the sibling set, which depends on the path taken. Per-cell deduplication keeps the first reading, so beam expansion order theoretically influences the result. It wasn't possible to construct a case where this flips the answer: for a provider to outrank the issuer it must be broadly bad, and in that case the issuer stops standing out within it. Declared rather than fixed with untestable machinery (`context/rules.md` §1, YAGNI). |
| D4 | `TEMPORAL_MIN_DECLINES = 100` with no formal derivation | A judgment call made out of caution. `MIN_DECLINES = 20` has a direct justification: below it a single decline moves the share by more than 5pp. |
| D5 | Average ticket is the cell's mean over the window, not the distribution | Cost doesn't discriminate the value tail within the slice. |
| D6 | No playbook matching | `causalDimension` and the dominant code's family already come out ready for the next branch's matcher. |
| D7 | `MAX_INCIDENTS_PER_ROOT = 3` | Guard against a pathological loop; the real stop condition is the residual. A root with more than three simultaneous causes would report only the three densest ones. |
