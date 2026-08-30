import type { RollupRow, RoutingCoverage, SliceFilter } from "../detect/types.js";
import { beamSearch, cellKey, type Candidate } from "./beam-search.js";
import { MAX_INCIDENTS_PER_ROOT } from "./constants.js";
import { selectCausal } from "./parsimony.js";
import { residualDeficit } from "./residual.js";

export type Peel = { causal: Candidate; suppressedEchoes: SliceFilter[] };

// DD18: peel one cause at a time and let the residual decide when to stop.
// beamSearch returns nothing once the root residual stops being material, so
// the loop ends on the data; the cap only guards against a pathological run.
export function peel(
  rows: RollupRow[],
  root: SliceFilter,
  rootExpected: number,
  deltaPp: number,
  coverage: RoutingCoverage,
): Peel[] {
  const peels: Peel[] = [];
  const excluded: SliceFilter[] = [];

  while (peels.length < MAX_INCIDENTS_PER_ROOT) {
    const candidates = beamSearch(rows, root, rootExpected, deltaPp, coverage, excluded);
    const causal = selectCausal(candidates);
    if (causal === null) break;

    const carved = [...excluded, causal.cell];
    const suppressedEchoes = candidates
      .filter(
        (candidate) =>
          cellKey(candidate.cell) !== cellKey(causal.cell) &&
          residualDeficit(rows, candidate.cell, candidate.expectedRate, deltaPp, carved).state !==
            "MATERIAL_DROP",
      )
      .map((candidate) => candidate.cell);

    peels.push({ causal, suppressedEchoes });
    excluded.push(causal.cell);
  }

  return peels;
}
