import type { Dimensions } from "@control-tower/contracts";

// Cell predicates for incident identity, which detector.md puts in
// `orchestrate/` alongside the fingerprint and the lifecycle.
//
// `compatible` is deliberately its own copy of the predicate `diagnose/run.ts`
// uses to match a signal against a diagnosis, in the same spirit as the
// playbook map duplicated in memory.ts: the two answer different questions
// ("did the peel already reach this signal" vs "is this the incident already on
// the operator's screen"), and importing one out of the other would run a
// back-edge across the boundary for four lines of predicate.

export type Cell = Dimensions;

function keysOf(left: Cell, right: Cell): Array<keyof Cell> {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])] as Array<keyof Cell>;
}

// Two cells describe the same place unless they disagree on a dimension both
// name: `stripe` covers `stripe x itau`, while `adyen` cannot.
export function compatible(left: Cell, right: Cell): boolean {
  return keysOf(left, right).every(
    (key) => left[key] === undefined || right[key] === undefined || left[key] === right[key],
  );
}

// How many dimensions a cell fixes. Used to pick the narrowest live incident a
// diagnosis is compatible with, so a coarse reading of an ongoing fault updates
// the incident that names it precisely instead of the merchant-wide one.
export function specificity(cell: Cell): number {
  return Object.values(cell).filter((value) => value !== undefined).length;
}
