import type { InvestigationStep } from "@control-tower/contracts";
import { aggregate, matchesFilter } from "../detect/aggregate.js";
import type { Dimension, RollupRow, SliceFilter } from "../detect/types.js";
import { FREE_DIMENSIONS } from "./beam-search.js";
import type { Diagnosis } from "./run.js";

/**
 * The deterministic counterpart of the agent's investigation trail.
 *
 * The beam search already asks the questions in roadmap §2 — which provider,
 * then which method, then which issuer, then what the residual clears — it
 * just never wrote them down. This replays that walk over the same rollups so
 * the evidence panel has something to show when the agentic layer is absent or
 * timed out, which is the path the cut list (roadmap §7) makes most likely.
 *
 * Every step is recomputed from `rows`, so no number here can disagree with
 * the diagnosis it accompanies.
 */
export function buildTrail(rows: RollupRow[], diagnosis: Diagnosis): InvestigationStep[] {
  const steps: InvestigationStep[] = [];
  const parent: SliceFilter = { ...diagnosis.root };

  const fixed = FREE_DIMENSIONS.filter((dimension) => diagnosis.cell[dimension] !== undefined);
  // An inconclusive diagnosis fixed nothing, and the sweep that came up empty
  // IS its evidence: showing the siblings sitting level is what distinguishes
  // "we found no culprit" from "we did not look".
  const walked = fixed.length > 0 ? fixed : FREE_DIMENSIONS;

  for (const dimension of walked) {
    const rates = ratesBy(rows, parent, dimension);
    if (Object.keys(rates).length === 0) continue;

    const value = diagnosis.cell[dimension];
    steps.push({
      stepNo: steps.length + 1,
      actor: "fallback",
      toolName: "query_slice",
      toolArgs: { filter: { ...parent }, splitBy: dimension },
      toolResult: value === undefined ? { rates } : { rates, fixed: value },
      reasoning: null,
    });
    if (value !== undefined) parent[dimension] = value;
  }

  steps.push({
    stepNo: steps.length + 1,
    actor: "fallback",
    toolName: "residual_test",
    toolArgs: { cell: diagnosis.cell },
    toolResult: {
      suppressed: diagnosis.suppressedEchoes,
      explainedDeficit: diagnosis.explainedDeficit,
    },
    reasoning: null,
  });

  const mix = diagnosis.declineMix;
  if (mix !== null) {
    steps.push({
      stepNo: steps.length + 1,
      actor: "fallback",
      toolName: "decline_mix",
      toolArgs: { cell: diagnosis.cell, windowMin: mix.windowUsed },
      toolResult: {
        dominantCode: mix.dominantCode,
        referenceSource: mix.referenceSource,
        totalDeclines: mix.totalDeclines,
        shifts: mix.shifts,
      },
      reasoning: null,
    });
  }

  return steps;
}

// The sibling comparison behind every drill-down step: one rate per value the
// dimension actually takes under `parent`.
function ratesBy(
  rows: RollupRow[],
  parent: SliceFilter,
  dimension: Dimension,
): Record<string, number> {
  const values = [
    ...new Set(rows.filter((row) => matchesFilter(row, parent)).map((row) => row[dimension])),
  ];
  const rates: Record<string, number> = {};
  for (const value of values) {
    rates[value] = aggregate(rows, { filter: { ...parent, [dimension]: value } }).rate ?? 0;
  }
  return rates;
}
