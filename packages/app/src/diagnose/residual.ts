import type { CellState } from "@control-tower/contracts";
import { aggregate, matchesFilter } from "../detect/aggregate.js";
import { MIN_VOLUME } from "../detect/constants.js";
import type { RollupRow, SliceFilter } from "../detect/types.js";
import { evaluate, type Interval } from "../detect/wilson.js";

export type ResidualResult = {
  attempts: number;
  approved: number;
  rate: number | null;
  ci: Interval;
  state: CellState;
  deficit: number;
};

// The one primitive behind echo suppression, beam scoring and the peeling stop
// condition: re-read a slice with a set of cells carved out of it.
export function residualDeficit(
  rows: RollupRow[],
  filter: SliceFilter,
  expected: number,
  deltaPp: number,
  excluded: SliceFilter[] = [],
): ResidualResult {
  const kept = rows.filter((row) => !excluded.some((cell) => matchesFilter(row, cell)));
  const agg = aggregate(kept, { filter });
  const { state, ci } = evaluate(agg.approved, agg.attempts, expected, deltaPp, MIN_VOLUME);
  return {
    attempts: agg.attempts,
    approved: agg.approved,
    rate: agg.rate,
    ci,
    state,
    deficit: Math.max(0, agg.attempts * expected - agg.approved),
  };
}
