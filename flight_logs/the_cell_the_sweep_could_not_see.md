# The sweep does not split issuers inside each provider — tried, measured, reverted

> **Reverted.** The change this log proposed shipped as `c1ffd0d` and was backed
> out. Everything below about *why the cell is invisible* holds and is worth
> keeping; the conclusion that depth was the answer did not survive contact with
> production. The measurement that killed it is at the end.

**Decisions:** extends `crossSectionalSweep` and `temporalSweep` in
`detect/trigger.ts` with a fourth family of splits. Completes the pair
`incident_identity_by_containment.md` and `reconfirm_while_the_drop_stands.md`:
those two made one fault stay one incident; this one makes the second fault
visible at all.

## The measurement

Both faults injected at 19:01 on 2026-09-04, on the build carrying both earlier
fixes, and left running for 23 minutes:

```
6ec134fc  stripe x itau    one incident, detected_at bumped every window 19:03 -> 19:22
fe5e6d62  adyen x nubank   detected 19:09, resolved 19:12, never seen again
```

The severe cause behaved exactly as intended. The moderate one — `adyen x
nubank` at ~0.32 against a 0.90 baseline, with ~36 attempts a minute — opened an
incident once and then went invisible for eleven minutes while it was still
running. Identity was not the problem: no duplicate ever opened. Nothing was
arriving at all.

## Why it was invisible

`splitsOf` only ever descended one dimension below the merchant x country root:
by provider, by issuer within CARD, and by payment method. A cause confined to
one provider's traffic through one issuer is never tested on its own, so it can
only be seen through a slice that averages it with healthy traffic:

```
                       itau    nubank   slice
        stripe         0.09     0.92    0.505
        adyen          0.92     0.32    0.62
        slice          0.505    0.62
```

The provider slice for adyen is 0.62 against a sibling reference of 0.505 — it
reads *better* than expected. The issuer slice for nubank is 0.62 against 0.505 —
the same, by mirror image. Two effects compound: the healthy half of each slice
lifts the average, and the severe cause in the other corner drags the sibling
reference down to meet it. The fault is not merely hard to see, it is
arithmetically the wrong sign in both places. `masked-cell.test.ts` is that table.

Production matched it: the nubank issuer slice read 0.713 against a
parent-minus-child reference of 0.766 — 5.3pp, marginal — while the reference
without the contaminating sibling would have been 0.896, an 18.3pp drop. At that
margin the streak oscillated at 1/2 windows and `persistence.step` needs
consecutive ones, so it confirmed once and never re-accumulated.

## Options considered

- **Widen `temporalSweep`'s history.** The contamination is cross-sectional, and
  `e691b8a` already added the temporal lens for exactly that. It did not help
  here because it walks the *same* slices: a diluted cell is diluted against its
  own past too. The lookback is already 120 minutes.
- **Lower `minMaterialDropPp` or `MIN_VOLUME`.** Moves where the threshold sits
  without changing what is being measured, which is the mistake this project has
  now made three times.
- **Split the issuers inside each provider.** Compare the cell against a sibling
  the fault does not touch.

## What we chose

One more family of splits, one per covered provider: `{ merchantId, country,
paymentMethod: "CARD", providerId: p }` split by `issuerId`. Both sweeps get it,
since both take their slices from `splitsOf`.

`adyen x nubank` is then measured against `adyen x itau` — 0.32 against 0.92, a
60pp gap with no healthy traffic averaged in and no contaminated reference.

## Why

This is the depth the diagnosis already works at. `peel` and `beamSearch` reach
`provider x issuer` routinely — every incident in the measurement above is a
five-dimension cell — and `MAX_DEPTH` there is 3 below the root. The detector was
the narrower of the two, and a diagnosis can only refine a signal it was handed.
`86a411b` had already taught `runDiagnosis` to drill an unexplained signal on its
own; it never fired here because the signal never existed.

## What it costs

One extra split per covered provider per root: on the DD13 cube that is a
handful of additional cells per tick, all of them aggregations over rows already
in memory.

Thinner cells, and therefore more `INSUFFICIENT_EVIDENCE`. That is handled where
it already was — `tick.ts` retries a thin `MATERIAL_DROP` over the 5-minute
window (`THIN_CELL_WINDOW_MIN`) before giving up, and `MIN_VOLUME` still applies.
The measured cell sat at ~36 attempts a minute against a `MIN_VOLUME` of 30.

DD19 warns that fixing all five dimensions is usually too specific to defend.
That warning is about which cell a *diagnosis* names, and it still stands: the
peel decides that, on the residual. This only decides what the detector is
allowed to notice.


## What happened when it shipped

Four days of production, split at the deploy:

```
                          incidents/h   mean attempts per slice
before c1ffd0d                    5.4                       175
after  c1ffd0d                   21.2                        65
```

1853 incidents in the second phase, 836 of them on slices under 60 attempts, the
minimum sitting exactly on `MIN_VOLUME`. At night, when traffic thins, it reached
50+ an hour. Almost all of them diagnosed as root-level `INCONCLUSIVE`: the thin
signal fired, the peel found nothing to isolate, and the merchant root became an
incident.

## Why the reasoning was wrong

"What it costs" above weighed the extra cells as aggregation work and thin-cell
volume, and both of those were handled. It never counted the statistical cost:
the split multiplies the number of hypotheses tested per window by roughly four,
each at a fixed 95% level. Testing forty slices a minute at that level produces
false positives by construction, and `PERSISTENCE_WINDOWS` does not clear them —
a borderline thin cell stays borderline across consecutive windows.

That is `context/spec.md` §8, open question 3 — "como controlar múltiplas
comparações" — which the project has never answered. The masking this log
describes is real, and reaching it means answering that question first, not
descending another level and hoping the volume holds.

Criterion 1 of `spec.md` §4 outranks criterion 5 here: a board carrying fifty
invented incidents an hour is worse than one that occasionally misses the
smaller of two simultaneous causes.
