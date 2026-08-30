import { cellKey, type Candidate } from "./beam-search.js";
import { SELECTION_TOLERANCE } from "./constants.js";

function within(value: number, best: number): boolean {
  return value >= best * (1 - SELECTION_TOLERANCE);
}

function fixedDimensions(candidate: Candidate): number {
  return Object.values(candidate.cell).filter((value) => value !== undefined).length;
}

// Density, not absolute deficit, decides. The common ancestor of two
// simultaneous incidents always explains the largest absolute deficit — here it
// would be the whole CARD slice — so ranking by that collapses both incidents
// into one and defeats DD18. Lost approvals per attempt is maximised by the
// tightest slice where the loss actually lives; magnitude then breaks ties, and
// peeling recovers the remaining causes.
//
// Parsimony decides only what density cannot: cells covering the very same
// rows, which PIX implying BR makes a structural certainty (roadmap.md §4).
export function selectCausal(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;

  const bestConcentration = Math.max(...candidates.map((c) => c.concentration));
  const densest = candidates.filter((c) => within(c.concentration, bestConcentration));

  const bestExplained = Math.max(...densest.map((c) => c.explainedDeficit));
  const largest = densest.filter((c) => within(c.explainedDeficit, bestExplained));

  return [...largest].sort(
    (a, b) =>
      fixedDimensions(a) - fixedDimensions(b) || cellKey(a.cell).localeCompare(cellKey(b.cell)),
  )[0]!;
}
