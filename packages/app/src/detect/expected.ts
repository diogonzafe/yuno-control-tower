import { aggregate } from "./aggregate.js";
import type { Dimension, RollupRow, SliceFilter } from "./types.js";
export function crossSectionalExpected(rows: RollupRow[], parent: SliceFilter, splitDim: Dimension, childValue: string): number | null { return aggregate(rows, { filter: parent, exclude: { [splitDim]: childValue } }).rate; }
export function temporalExpected(history: RollupRow[], filter: SliceFilter, from: string, to: string): number | null { return aggregate(history.filter((r) => r.bucket >= from && r.bucket < to), { filter }).rate; }
