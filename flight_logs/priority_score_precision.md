# `priority_score` is minor units per minute, and the column has to hold them

## Options considered

- **Widen the column** to `NUMERIC(20,4)`, matching the range of the
  `cost_usd_per_min BIGINT` it is copied from.
- **Change the unit**, storing `costUsdPerMin / 100` so the number is USD, as
  `priority_by_conservative_cost.md` describes it.

## What we chose

Widened `incidents.priority_score` to `NUMERIC(20,4)` (migration
`0004_priority_score_precision`), and documented in `context/schema.md` that the
unit is USD *minor* units per minute — the same unit as `cost_usd_per_min`.

## Why

`diagnose/cost.ts` sets `priorityScore = costUsdPerMin`, and `costUsdPerMin` is
in cents. `NUMERIC(10,4)` tops out at 999999.9999, so any incident past roughly
**$10k per minute** failed the INSERT with `numeric field overflow`. The failure
lands in `openOrUpdate`, inside the orchestration catch in `run.ts` — so the
incidents that silently never opened were, by construction, the most expensive
ones the system will ever see. An E2E run found it: `full-flow.e2e.test.ts` had
its ticket scaled from 100 USD down to 5 USD to stay under the ceiling, and the
comment saying so was the report.

Changing the unit instead would break the invariant `priorityScore ===
costUsdPerMin` that `cost.test.ts` locks in and `agent/tools.ts` exposes to the
investigator, and it would silently divide every stored score by 100 against
rows already written. The column is a ranking key: nothing reads it as a
displayed figure (the UI formats `cost_usd_per_min`, which already divides by
100 in `web/src/lib/status.ts`), so the range is the only property that matters.

**What the choice costs.** The name still says USD while the unit is cents, and
the four decimal places are now decoration on a value that is integral by
construction. We keep both rather than renaming a column mid-hackathon, and pay
for it with an explicit comment at the column and in the normative DDL.
