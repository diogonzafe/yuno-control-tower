# The investigation trail is also assembled without an LLM, and the fingerprint carries the dominant decline

**Decisions:** completes `who_assembles_the_evidence_object.md`, which fixed *who*
assembles the `EvidenceObject` but did not say what goes into two of its fields —
`investigationTrail` when there was no agent, and `fingerprint`.

## Options considered

**For the trail on the deterministic path:**

- **Empty trail.** `investigationTrail: []` until the agentic layer exists.
  `buildEvidence` stays as pure translation, recomputing nothing.
- **The beam search records as it searches.** `beamSearch` starts emitting the
  steps it already takes, and the trail comes for free along with the candidates.
- **Reproduce the search afterwards**, in a separate module, from the same
  rollups and the already-finished diagnosis.

**For the fingerprint:**

- **Dimensions only**, reusing `fingerprint()` from `detect/persistence.ts`.
- **Dimensions plus the dominant decline code.**

## What we chose

`diagnose/trail.ts` reproduces the search after the fact: one `query_slice` step
per dimension that the diagnosis fixed, showing the siblings' rates at that level,
then a `residual_test` with the suppressed echoes and a `decline_mix` when there
is a mix. When nothing stood out, it scans the three free dimensions and fixes
none — the empty scan is the evidence that we looked. All steps come out with
`actor: "fallback"`.

The `fingerprint` is `cellKey(cell)` plus `#<dominant code>` when there is one.

## Why

Having the beam search record the trail would be cheaper in CPU, but it puts
presentation responsibility inside the search loop, which is the most delicate
part of the system and the one that will change the most before delivery. The cost
of the choice is recomputing aggregates the search had already computed —
irrelevant in a 90-cell window — and the risk of the replay order diverging from
the search's real order, which is why `FREE_DIMENSIONS` is now exported from
`beam-search.ts` instead of duplicated.

An empty trail was the most honest option while the agent does not exist, and it
was discarded by the cut list of `roadmap.md` §7: the agentic layer is the fourth
item to be sacrificed, and the evidence panel (RF3, criterion 3) is what proves
the drill-down on the screen. A deterministic trail means the panel works exactly
the same with or without an LLM — which is the same promise `rules.md` §3 already
makes for the entire evidence object.

Including the dominant decline in the fingerprint follows the comment that
`incidents.fingerprint` already carried in `db/schema.ts`. What it costs: the same
cell breaking again for a different reason opens a new incident instead of
updating the previous one. This is the desired behavior — "Adyen×BR×CARD×Itaú with
`05` at 78%" and "the same cell with `91` spread out" are different diagnoses,
with different playbooks — but it means the repeat memory by exact fingerprint
recognizes fewer cases than it would with a dimensions-only key. The approximate
path via pgvector (DD15) exists precisely to cover that gap.

## Implementation note

`buildEvidence` receives `{ diagnosis, rows, diagnosisSource, investigationTrail? }`,
and not the `(signal, diagnosis, trail?)` sketched in
`who_assembles_the_evidence_object.md`. The `ConfirmedDrop` is not included because the
causal cell is almost never the signal's cell: the signal points to the root or
the provider, the peeling descends to the issuer. Copying `expectedSource` or
`observedRate` from the signal would describe a different slice from the one the
incident reports. The four fields that only detection knows (`expectedSource`,
`deltaPp`, `windowUsed`, `consecutiveWindows`) now travel in the `Diagnosis`
itself, derived per cell in `diagnose/run.ts`.
