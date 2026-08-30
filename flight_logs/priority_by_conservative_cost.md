# Prioritize by cost per minute at the conservative end, with no confidence weight

## Options considered

- **Cost per minute multiplied by a confidence factor** derived from the interval
  width or the strength of the decline evidence.
- **A composite score** of money, affected volume, and deviation severity, with
  configurable weights.
- **Pure cost per minute**, computed with the optimistic end of the Wilson
  interval.

## What we chose

`priority_score` is the cost per minute in USD, and nothing else. Lost approvals
come from `attempts × (expected − ci_high)`, accumulated from `started_at` to the
detection window, and the cost per minute is that total divided by the duration.
There is no separate confidence factor, and no weight to configure.

The cost is also reported in the country's local currency, with the average ticket
of the slice itself, for the operations reading.

## Why

The confidence weighting **is already inside the number**, and that is what makes
the separate factor redundant. The calculation uses `ci_high`, the optimistic end:
an incident with a small sample has a wide interval, therefore a high `ci_high`,
therefore fewer attributable approvals, therefore less money and less priority.
The uncertainty already discounts the ranking by construction. Adding a confidence
factor on top would apply the same discount twice.

This gives a short answer to the predictable Q&A question — "how do you weight
uncertainty in prioritization?" — and it does not depend on any invented
constant: the only parameter of the test remains the 95% confidence level fixed in
DD11.

Money as the sole criterion is also what `context/spec.md` insists on demanding
and is the executive's language. A composite score with weights would require
justifying each weight, and weights chosen without data are the kind of piece a
judge takes apart.

Using `ci_high` instead of the observed rate turns the number into a floor: the
sentence that goes on the slide is "we are losing **at least** X per minute". In
our test fixture the difference is concrete — the observed rate would charge 255
lost approvals, the conservative end charges 243.

**What the choice costs.** We deliberately underestimate the loss, and in a
low-volume cell the underestimation is large, because the interval is wide. A
small but real incident can be ranked poorly for lack of sample, not for lack of
importance. We accept this because erring low on a number that goes to the
executive is the cheap error, and because the `INSUFFICIENT_EVIDENCE` state exists
precisely for the case where the sample does not support any claim. We also ignore
the average ticket varying within the slice: we use the cell's mean over the
incident window, not the distribution.
