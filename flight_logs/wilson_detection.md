# The detector uses the Wilson interval; the output is the `ConfirmedDrop` contract, without touching `incidents`

**Decisions:** confirms DD11 (Wilson, already reflected in `context/schema.md`
v3+). Fixes the detector's output contract and the deterministic boundary of the
detection engine. Full spec in `context/detector.md` (`YCT-DETECT-001`).

## Options considered

**Per-cell test statistic:**

- **Bayesian beta-binomial** — needs a prior-strength parameter to calibrate and
  justify in the technical Q&A; no closed library in TS.
- **Proportion z-test / chi-square** — classic, but requires controlling multiple
  comparisons by hand over thousands of cells, and does not deliver a readable
  interval for the UI.
- **Wilson interval** — closed-form formula (~8 lines), no dependency, no prior;
  the only parameter is the confidence level (95%, `z = 1.96`). The interval is
  exactly the evidence visual that the screen shows.

**Detector output boundary:**

- **The detector writes to `incidents`** — joins detection, fingerprint dedup,
  lifecycle, and memory in a single module; pulls the database, `docker-compose`,
  and pgvector into the statistics front.
- **The detector emits a typed in-memory signal and stops** — the orchestrator
  (deterministic, next branch) persists and manages the `incidents` row.

**Scope of the depth-1 transverse scan:**

- **From the global root** (wording of `context/roadmap.md` §2, "children of the
  root").
- **From each `merchant × country`**, splitting by provider, issuer, and method.

## What we chose

- **Wilson**, `z = 1.96`, with persistence of **3 consecutive windows** in
  `MATERIAL_DROP` to confirm. `evaluate()` returns 4 states (`MATERIAL_DROP`,
  `HEALTHY`, `MONITORING`, `INSUFFICIENT_EVIDENCE`); the detector acts only on the
  first, persistent one.
- **DB-agnostic deterministic core**: the modules in `packages/app/src/detect/`
  are pure functions that receive `RollupRow[]`. `db/queries.ts` stays only as the
  `RollupSource` interface; the cube SQL and the ingestion are next branches.
- The detector emits **`ConfirmedDrop`** (Zod, `packages/contracts/src/incident.ts`)
  already with `ci_low`/`ci_high`, `current_rate`, `baseline_rate`,
  `started_at`/`started_at_exact` computed. It also emits **`EvidenceGap`** for
  slices with no volume — the "admits it doesn't know" bonus from
  `context/spec.md` §5. No `incidents`, cost, `priority_score`, decline-mix,
  residual test, or LLM in this branch.
- **Transverse scan rooted at `merchant × country`.**

## Why

- Wilson takes the prior parameter off the table (one less piece in the technical
  defense), has no dependency, and the interval becomes the direct visual
  evidence. Overnight noise is covered by the wide interval at low volume, not by
  a seasonal baseline (consistent with DD7 / `fixed_expected_conversion.md`).
- `context/schema.md` v3 already said "the beta-binomial goes out in favor of the
  Wilson interval (DD11)", and `roadmap.md` and `rules.md` §6.6 already carried
  Wilson. Only `AGENTS.md` kept an obsolete conflict note ("DD11 specifies
  beta-binomial ... do not implement until confirmed"). This flight log closes the
  divergence; the branch commit fixes `AGENTS.md`.
- Separating the detector from the orchestrator keeps the statistics front free of
  a database, the way `roadmap.md` §5/§6 sequences it (`F0 → F1 → F2`), and keeps
  the interface between the two small and testable (`ConfirmedDrop`).
- A scan from the global root does not catch "issuer X drops only for merchant M"
  — the global rate of X across the 3 merchants may stay healthy — and that is
  half of the mandatory minimum case in `context/spec.md` §4. Running inside
  `merchant × country` covers both scenarios by construction.

**Cost of each choice:**

- **DB-agnostic:** the branch does not run end to end. It needs a following branch
  for `db/client.ts`, the raw cube SQL, and the `RollupSource` implementation, and
  another for the ingestion, before there is a demo.
- **No residual test here:** the tick can emit both `{merchant, country}`
  (absolute trigger) and `{merchant, country, +dim}` (transverse) for the same
  cause. Shadow suppression is left to `diagnose/residual.ts` + orchestrator; the
  `ConfirmedDrop` already carries what the residual test needs.
- **Root at `merchant × country`:** diverges from the wording of `roadmap.md` §2.
  Aligned in the same commit with a pointer in `context/schema.md` §6; the
  roadmap's narrated example stays as is.
- **`MONITORING` with no action:** the state exists in `evaluate()` and in the
  tests for fidelity to `schema.md` §6.3, but never becomes a signal — a subtlety
  to explain if a judge asks.
