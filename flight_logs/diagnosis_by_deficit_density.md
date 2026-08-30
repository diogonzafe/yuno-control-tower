# Choose the causal cell by deficit density, not by absolute deficit

## Options considered

### How to score a candidate

- **Absolute explained deficit** — how many of the root's lost approvals disappear
  when the cell is excluded.
- **Deficit density** — the same explained deficit, divided by the attempts of the
  excluded slice.
- **Fraction of explained deficit above a fixed threshold** — accept the cell that
  explains more than X% of the drop.

### How to compose the modules

- Enumerate every cell down to depth 3 and cluster the anomalous ones.
- A single greedy descent: at each level, descend into the child with the largest
  deficit.
- A peeling loop wrapping a top-down beam search.

### Who computes the echo suppression

- A separate step, after the cause is chosen.
- The same function that scores the candidates.

## What we chose

The primary score is **deficit density**: explained deficit per attempt of the
excluded slice. Magnitude only breaks ties, and parsimony decides last. No
fraction threshold was introduced.

The composition is a **peeling loop wrapping a beam search** of depth 3 (DD19),
with width 4. We use neither clustering nor greedy descent.

There is a single primitive, `residualDeficit`, and it has three consumers: the
beam search uses it to score, the peeling uses it as a stopping condition, and the
echo suppression uses it to test the remaining candidates. The residual test
stopped being a late step and became the scoring function.

## Why

The absolute deficit **does not work with simultaneous incidents**, and this is
not theory: the test covering acceptance criterion #5 of the briefing failed
because of it. With two disjoint causes under the same root, the common ancestor
of the two — in our case the entire `paymentMethod=CARD` slice — explains the 347
points of deficit, more than any isolated cause explains on its own. Ranking by
absolute value elects the ancestor, the peeling removes both incidents at once,
and the system reports one incident where there are two. That contradicts DD18 and
brings down the mandatory scenario.

Density does not have that problem, and it has a direct reading: with the deficit
computed with a sign, `explained deficit / attempts` is exactly
`expected − observed rate of the slice`, that is, the depth of the drop in that
slice. It grows as the search approaches the bad cell and is indifferent to the
size of the rest of the cube. In the Q&A the answer is one sentence: we report the
narrowest slice where the loss is dense, not the largest slice that contains it.

Clustering had already been discarded in `context/roadmap.md` §4 for being more
general and easier to get wrong under pressure; reopening it would require a
recorded discussion against DD18. Greedy descent is the one with the least code,
but a single path does not find two simultaneous incidents and does not survive a
structural tie of the `PIX ⇒ BR` kind.

We did not introduce an explained-fraction threshold because it would be one more
arbitrary constant to defend. Admissibility is already the conjunction of two
conditions that the data support on their own: the cell has a material drop by the
Wilson interval, and excluding it strictly reduces the root's deficit. What ends
the loop is the residual, as DD18 foresaw.

**What the choice costs.** Density is maximized by severity, not by size: a small,
badly broken cell can be chosen before a large, less broken one. We accept this
because the peeling finds the second one on the next pass and the final
prioritization orders by money per minute, where the largest wins — the peeling's
internal order does not leak to the user. We also pay the cost of recomputing the
root's residual once per evaluated candidate; with 90 cells (DD13) this is
irrelevant, but it would not scale to a large cube without memoization.
