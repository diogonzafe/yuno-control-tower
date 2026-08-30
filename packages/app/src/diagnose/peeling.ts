import type { RollupRow, RoutingCoverage, SliceFilter } from "../detect/types.js";
import { beamSearch, cellKey, type Candidate } from "./beam-search.js";
import { MAX_INCIDENTS_PER_ROOT } from "./constants.js";
import { selectCausal } from "./parsimony.js";
import { residualDeficit } from "./residual.js";

// A slice that looked anomalous on its own and stopped looking anomalous once
// the cause was carved out. Both rates travel with it: the pair is the whole
// argument for suppressing it, and the evidence panel shows them side by side
// ("Brazil reads 53%, and 95% without Adyen x Itau"). `residualRate` is null
// when the carve-out leaves the slice empty — the cause swallowed it whole,
// so there is no residual to read.
export type Echo = { cell: SliceFilter; observedRate: number; residualRate: number | null };

export type Peel = { causal: Candidate; suppressedEchoes: Echo[] };

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
      .filter((candidate) => cellKey(candidate.cell) !== cellKey(causal.cell))
      .map((candidate) => ({
        candidate,
        residual: residualDeficit(rows, candidate.cell, candidate.expectedRate, deltaPp, carved),
      }))
      .filter(({ residual }) => residual.state !== "MATERIAL_DROP")
      .map(({ candidate, residual }) => ({
        cell: candidate.cell,
        observedRate: candidate.observedRate,
        residualRate: residual.rate,
      }));

    peels.push({ causal, suppressedEchoes });
    excluded.push(causal.cell);
  }

  return peels;
}
