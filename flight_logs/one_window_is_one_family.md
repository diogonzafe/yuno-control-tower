# One window is one family: the sweep corrects z for how many slices it tests

**Decisions:** answers `context/spec.md` §8 open question 3 — "como controlar
múltiplas comparações" — and refines DD11. `Z = 1.96` remains exactly the value
for a single test; `familyWiseZ(1)` returns it, so DD11 is the m = 1 case of this
rule rather than something it contradicts.

## The measurement

`BR_STORE_02 x BR x CARD`, three issuer slices over three hours:

```
  itau      3728 attempts   0.897
  nubank    3720 attempts   0.898
  bradesco  3686 attempts   0.902
```

Three healthy issuers, indistinguishable, no fault anywhere. The same slices
minute by minute:

```
  02:56  bradesco  15 attempts  0.800
  02:56  itau      19 attempts  1.000
  02:58  itau      16 attempts  0.750
  02:58  nubank    13 attempts  1.000
```

Eleven to twenty-four attempts each. At that size the rate swings between 0.75
and 1.00 by sampling alone, and one of those windows read 0.868 against siblings
at 0.973 and confirmed. The incident carried 91 attempts, which is `retry()`
widening a thin candidate over `THIN_CELL_WINDOW_MIN` — five minutes at ~18
attempts.

Counted directly: the sweep tests **69 slices a minute** on the current cube —
9 roots, 27 provider slices, 27 issuer slices, 6 payment-method slices — near
99,000 tests a day, every one at a fixed 95%. A few confirmed drops an hour on
healthy cells is the arithmetic consequence, not a defect in any one of them.
`spec.md` §7a predicted exactly this: brute force over every cell each window
"enche de falso positivo por múltiplas comparações".

## Options considered

- **Raise `MIN_VOLUME`** from 30 to ~150, so thin slices are never tested. Moves
  a threshold without changing what is measured — the mistake this project made
  three times in one day — and blinds the detector to real faults in issuer
  slices exactly when traffic is thin.
- **Accept it.** Every one of these is marked `INCONCLUSIVE`, which is honest.
  But criterion 1 of `spec.md` §4 is that the system does not fire on noise, and
  a board carrying invented incidents overnight fails it.
- **Correct for the family.** Widen the interval by the number of hypotheses
  tested together.

## What we chose

Šidák over the count of slices actually tested in the window:
`α_test = 1 - (1-0.05)^(1/m)`, `z = Φ⁻¹(1 - α_test/2)`. At m = 69 that is
z ≈ 3.37.

`runDetectionTick` builds the full candidate list first, counts it, and
re-evaluates every verdict with that z before deduping. The sweeps still decide
one test at a time on the way there; the tick is the only place that knows how
many there were.

`Φ⁻¹` is Acklam's rational approximation — deterministic and dependency-free,
which `rules.md` §3 requires of the numeric path. A lookup table was discarded:
the count moves with the shape of the traffic, so the z is not known in advance.

## Why Šidák, and why the family is the window

Šidák is exact for independent tests and costs the same as Bonferroni; at these
counts they differ in the third decimal. The slices are not independent — a
provider slice contains its issuer slices — so both are conservative here, which
is the direction to err in when the alternative is inventing incidents.

The family is one window because that is the unit of decision: every slice is
tested against the same minute of rollups and any of them can raise an alert.

## What it costs

A real fault has to clear a wider bound. The two readings that matter, both from
production:

```
                               n     observed   limit    ci_high @1.96   @3.37
  healthy slice (BR_STORE_02)  91      0.868     0.943      0.938        0.988
  injected fault (stripe×itau) 45      0.089     0.870      0.174        0.234
```

The noise is silenced and the injected fault still clears its limit by more than
sixty points. Faults worth alerting on are not near the boundary; the ones that
were near it are the ones that should not have fired.

Detection of a genuinely marginal fault gets slower — it now needs either more
volume or a larger effect. That is the trade this buys, and it is the right one:
the detector's promise is that a confirmed drop is real.

What this does not touch: `diagnose/beam-search.ts` runs its own `evaluate` over
the cube, and keeps the single-test z. It only ever runs on a signal the detector
already confirmed, and its job is to localise a fault rather than decide whether
one exists — correcting a search for the best explanation is a different question
from correcting a decision to alert.
