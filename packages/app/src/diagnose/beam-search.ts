import { aggregate, matchesFilter } from "../detect/aggregate.js";
import { MIN_VOLUME } from "../detect/constants.js";
import { crossSectionalExpected } from "../detect/expected.js";
import type { Dimension, RollupRow, RoutingCoverage, SliceFilter } from "../detect/types.js";
import { evaluate, type Interval } from "../detect/wilson.js";
import { BEAM_WIDTH, MAX_DEPTH } from "./constants.js";
import { residualDeficit } from "./residual.js";

// The root already fixes merchant and country (DD17), so only three dimensions
// are left to divide by.
// Exported because the fallback trail (trail.ts) has to replay this same
// drill-down order: a trail that walked the dimensions differently would be
// describing a search the system never ran.
export const FREE_DIMENSIONS: Dimension[] = ["providerId", "paymentMethod", "issuerId"];

export type Candidate = {
  cell: SliceFilter;
  depth: number;
  attempts: number;
  approved: number;
  observedRate: number;
  expectedRate: number;
  ci: Interval;
  explainedDeficit: number;
  concentration: number;
};

export function cellKey(cell: SliceFilter): string {
  return Object.entries(cell)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dimension, value]) => `${dimension}=${value}`)
    .join("|");
}

function splitValues(
  rows: RollupRow[],
  parent: SliceFilter,
  dimension: Dimension,
  coverage: RoutingCoverage,
): string[] {
  const parentRows = rows.filter((row) => matchesFilter(row, parent));
  // PIX rows carry issuer "NA": splitting by issuer before the slice is
  // card-only would compare a bank against a placeholder.
  if (dimension === "issuerId" && parentRows.some((row) => row.paymentMethod !== "CARD")) return [];
  const present = [...new Set(parentRows.map((row) => row[dimension]))];
  if (dimension === "issuerId") return present;
  const covered = new Set(
    coverage
      .filter((entry) => entry.country === parent.country)
      .map((entry) => (dimension === "providerId" ? entry.providerId : entry.paymentMethod)),
  );
  return present.filter((value) => covered.has(value));
}

function rank(a: Candidate, b: Candidate): number {
  return (
    b.explainedDeficit - a.explainedDeficit ||
    b.concentration - a.concentration ||
    a.depth - b.depth ||
    cellKey(a.cell).localeCompare(cellKey(b.cell))
  );
}

export function beamSearch(
  rows: RollupRow[],
  root: SliceFilter,
  rootExpected: number,
  deltaPp: number,
  coverage: RoutingCoverage,
  excluded: SliceFilter[] = [],
): Candidate[] {
  const rootResidual = residualDeficit(rows, root, rootExpected, deltaPp, excluded);
  if (rootResidual.state !== "MATERIAL_DROP") return [];

  const kept = rows.filter((row) => !excluded.some((cell) => matchesFilter(row, cell)));
  const admissible = new Map<string, Candidate>();
  let beam: SliceFilter[] = [root];

  for (let depth = 1; depth <= MAX_DEPTH && beam.length > 0; depth++) {
    const level = new Map<string, Candidate>();

    for (const parent of beam) {
      for (const dimension of FREE_DIMENSIONS) {
        if (parent[dimension] !== undefined) continue;
        for (const value of splitValues(kept, parent, dimension, coverage)) {
          const cell = { ...parent, [dimension]: value } as SliceFilter;
          if (level.has(cellKey(cell))) continue;
          const expectedRate = crossSectionalExpected(kept, parent, dimension, value);
          if (expectedRate === null) continue;

          const agg = aggregate(kept, { filter: cell });
          const { state, ci } = evaluate(agg.approved, agg.attempts, expectedRate, deltaPp, MIN_VOLUME);
          const explainedDeficit =
            rootResidual.deficit -
            residualDeficit(rows, root, rootExpected, deltaPp, [...excluded, cell]).deficit;

          const candidate: Candidate = {
            cell,
            depth,
            attempts: agg.attempts,
            approved: agg.approved,
            observedRate: agg.rate ?? 0,
            expectedRate,
            ci,
            explainedDeficit,
            concentration: agg.attempts === 0 ? 0 : explainedDeficit / agg.attempts,
          };
          level.set(cellKey(cell), candidate);
          if (state === "MATERIAL_DROP" && explainedDeficit > 0) {
            admissible.set(cellKey(cell), candidate);
          }
        }
      }
    }

    // A diluted parent can score worse than its own child, so the beam carries
    // every child forward on rank, not only the ones already admissible.
    beam = [...level.values()].sort(rank).slice(0, BEAM_WIDTH).map((candidate) => candidate.cell);
  }

  return [...admissible.values()].sort(rank);
}
