# The sweep splits issuers inside each provider, because that cell is invisible everywhere else

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
