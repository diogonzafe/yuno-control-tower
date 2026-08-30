# Compare the decline mix against the catalogue, with the cell as a refinement

## Options considered

### What to measure the share shift against

- **Only `decline_codes.baseline_share`**, the constant published in the catalogue.
- **Only the cell's own historical mix**, following the letter of
  `context/schema.md` §8 ("the comparison is against the cell's normal mix").
- **The catalogue as the default and the cell as a refinement**, when it has
  enough declines to be the better estimate.

### Who resolves code 91

- The investigator agent, as domain judgment.
- The playbook engine, matching family with causal dimension.
- A deterministic rule over the dispersion, inside `diagnose/`.

## What we chose

The primary reference is `decline_codes.baseline_share`. The cell's own historical
mix takes over when it accumulates at least 100 declines in the queried window.
The result carries `referenceSource`, the same way the `ConfirmedDrop` already
carries `expectedSource`.

The window widens on its own: 1 minute, then 5, then 15, until it adds up to at
least 20 declines, and the result reports which window was used.

The disambiguation of `91` and `AB03` is **deterministic and lives in
`diagnose/decline-mix.ts`**: concentrated in one provider across issuers, it is
the provider; concentrated in one issuer across providers, it is the issuer;
spread across all providers on PIX, it is the rail, and in that case there is no
recommendable action.

## Why

The catalogue needs no warm-up, and that is exactly the argument DD7 already
accepted for the expected conversion. Having both sources with the same
justification means one answer in the Q&A, not two. Using only the catalogue,
however, treats as a permanent incident any cell that structurally declines more
under one code — a Mexican issuer with more `51` would look shifted forever. Using
only the cell would be more faithful, but `context/schema.md` §8 itself warns that
a PIX cell produces about three declines per minute: the per-cell estimate is
noisy exactly where it would be most needed.

The window widening is the same idea as the thin-cell rule of DD14, applied to the
other rollup. Without it, a third of the cube would be permanently without a mix
reading.

The `91` stays on the deterministic side because it is the only catalogue code
that sustains two opposite diagnoses, and the difference between them is not
judgment: it is counting how many providers and how many issuers appear in the
dispersion. Leaving that to the LLM would be judgment over a number, which crosses
the first boundary of `context/rules.md` §3. And since every agentic path needs a
deterministic fallback, the rule would have to exist here anyway.

**What the choice costs.** The two thresholds — 20 declines to read the mix and
100 to prefer the cell — are constants we need to defend. The first has a direct
justification: below 20, a single decline moves the share by more than five
points, and the shift becomes noise. The second is a choice of prudence with no
formal derivation, and it is declared as such. Besides, by widening the window to
15 minutes we lose temporal resolution in the mix: we know the profile changed,
but not the minute it changed. The `started_at` still comes from the retroactive
scan over conversion (DD8), not from the mix.
