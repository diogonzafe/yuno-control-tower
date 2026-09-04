# Incident identity is containment of the cell, not equality of the fingerprint

**Decisions:** amends `deterministic_trail_and_fingerprint.md`, which made
`cellKey(cell)#<dominant code>` both the incident's identity and its historical
signature. The signature is unchanged and DD15 is untouched; only the identity
moves.

## What went wrong

Three consecutive fixes attacked the same symptom — one ongoing fault opening a
stream of incidents — from the key's side:

- `3531ff8` gave an injected incident a coherent decline signature, so the
  dominant code would stop being sampling noise.
- `6a551af` ranked the dominant code by share behind a Wilson bound instead of
  by movement, so a rare code could no longer win.
- A third was about to remove the code from the key entirely.

Each one changed *which* key the incident gets. None changed the fact that the
key is recomputed from scratch every window.

## The measurement

Cell `BR_STORE_01 x BR x stripe x CARD x itau`, 2026-09-04, on the deployment
carrying both fixes above:

```
17:17 | 52 attempts | 46 approved | 0.885   healthy
17:19 | 44 attempts |  7 approved | 0.159   drops
  ...   44 minutes between 0.07 and 0.24, ~35 attempts a minute
18:02 | 36 attempts |  5 approved | 0.139
18:03 | 50 attempts | 45 approved | 0.900   recovers
```

One continuous fault, ample volume, no ambiguity. It produced seven incidents,
each resolved after exactly `RESOLVE_AFTER_QUIET_WINDOWS`, every one of them
carrying the same `started_at` of 17:18 — the onset scan knew it was one fault
the whole time. The fingerprints alternated between `...providerId=stripe#05`
and `...providerId=stripe`, and at 18:03, the minute the fault ended, an eighth
opened at the merchant root.

## Why no key is stable

Every level of the key is a threshold test over a single one-minute window:

- the dominant decline code, by the Wilson bound in `decline-mix.ts` — and its
  reference share itself switches between the catalogue and the cell's own
  history at `TEMPORAL_MIN_DECLINES`;
- the causal cell, by the 2% `SELECTION_TOLERANCE` concentration band in
  `parsimony.ts`, which with two simultaneous causes under one root lets the two
  trade places, and lets the root-level `INCONCLUSIVE` branch win outright.

So "dimensions only" is not the stable key the third fix assumed it was. It
removes one of the two churning levels and leaves the other, which is how the
first two fixes each moved the oscillation instead of ending it.

## Options considered

- **A steadier estimator for the dominant code.** Attempted twice. The estimator
  is not the problem; deriving identity from any per-window estimate is.
- **Dimensions-only fingerprint.** Fixes the code axis, leaves the cell-depth
  axis, and reverses DD15's recognition key as a side effect.
- **The merchant x country root as the identity.** Genuinely stable — it is
  structural, not estimated — but it collapses two simultaneous causes into one
  incident and forfeits criterion 5 of `spec.md` §4.
- **Containment.** Identity is the question "does this diagnosis contradict a
  live incident's cell", not "does it equal a key".

## What we chose

`orchestrate/incidents.ts` matches this window's evidence against the live
incidents under the same merchant x country root and takes the narrowest one
whose cell it does not contradict — `orchestrate/cell.ts`, `compatible` and
`specificity`. `attachNarrative` uses the same test in place of the fingerprint
comparison it made before.

The fingerprint stays `cellKey(cell)#<dominant code>` and stays indexed. It is
now purely the historical signature `memory.ts` recalls by, which is the only job
DD15 and `spec.md` §7i ever gave it. It is refreshed alongside `dimensions` and
`dominant_decline` as the diagnosis sharpens, so a resolved incident is filed
under the signature it ended with rather than the one its first minute guessed.

## Why

Containment is the only relation in this pipeline that survives re-estimation.
`stripe` and `stripe x itau` are the same fault seen at two depths, and the
peel's choice between them is a 2% tie-break; `stripe x itau` and
`adyen x nubank` disagree on a dimension both name, and no re-estimation makes
them agree. The narrowest match wins so that a merchant-wide `INCONCLUSIVE`
reading of an ongoing fault updates the incident that names it precisely, instead
of opening the eighth card observed at 18:03.

## What it costs

An incident's `dimensions` could widen as well as narrow, when a later window
diagnosed the same fault less precisely. This log first recorded that as an
acceptable cost — "the row always describes the most recent diagnosis" — and
watching it happen showed the judgement was wrong. On 2026-09-04 at 21:23 an
incident that had read `stripe x itau` for twenty minutes was overwritten by the
root-level INCONCLUSIVE branch and its card stopped naming a culprit at all,
which is the one thing the product exists to do.

`openOrUpdate` now takes only the liveness marker from a reading coarser than
the incident it matches: `detected_at` moves, everything else stays. A wider view
of a fault is evidence that it is still running, not a better diagnosis of it —
and its measured columns describe the wider slice, so taking them left the row
naming one cell and costing another.

Two evidence objects in one tick whose cells are compatible but not equal —
which the rescue peel in `run.ts` dedupes by exact `cellKey`, not by containment
— now land on one incident and trigger two investigations for it. Wasteful, not
wrong; `attachNarrative` already guards the agent/fallback ordering.

`lifecycle.ts` still matches evidence gaps to incidents by exact cell equality
(`sameCell`), so a gap arriving for a cell the incident has since widened past
will read as a resolve rather than an inconclusive. Left alone deliberately:
that is the lifecycle's question, not identity's, and it is on the open list.
