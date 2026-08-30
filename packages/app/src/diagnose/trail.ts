import type { InvestigationAuditStep } from "@control-tower/contracts";
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
export function buildTrail(rows: RollupRow[], diagnosis: Diagnosis): InvestigationAuditStep[] {
  const steps: InvestigationAuditStep[] = [];
  const parent: SliceFilter = { ...diagnosis.root };
  const now = diagnosis.windowBucket;

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
      toolCallId: `fallback:${diagnosis.windowBucket}:${steps.length + 1}:query_conversion_slice`,
      toolName: "query_conversion_slice",
      toolArgs: { filter: { ...parent }, splitBy: dimension },
      toolResult: value === undefined ? { rates } : { rates, fixed: value },
      status: "completed",
      errorCode: null,
      decisionTag: "DRILL_DOWN",
      decisionSummary:
        value === undefined
          ? `Compared siblings for ${dimension} under the current root.`
          : `Fixed ${dimension}=${value} after comparing sibling conversion rates.`,
      hypothesis: value === undefined ? null : { dimension: mapDimension(dimension), value },
      evidenceStepNos: steps.length === 0 ? [] : [steps.length],
      createdAt: now,
      completedAt: now,
    });
    if (value !== undefined) parent[dimension] = value;
  }

  steps.push({
    stepNo: steps.length + 1,
    toolCallId: `fallback:${diagnosis.windowBucket}:${steps.length + 1}:run_residual_test`,
    toolName: "run_residual_test",
    toolArgs: { cell: diagnosis.cell },
    toolResult: {
      suppressed: diagnosis.suppressedEchoes,
      explainedDeficit: diagnosis.explainedDeficit,
    },
    status: "completed",
    errorCode: null,
    decisionTag: "VALIDATE_RESIDUAL",
    decisionSummary: "Validated that the selected cell explains the residual deficit.",
    hypothesis: null,
    evidenceStepNos: steps.length === 0 ? [] : [steps.length],
    createdAt: now,
    completedAt: now,
  });

  const mix = diagnosis.declineMix;
  if (mix !== null) {
    steps.push({
      stepNo: steps.length + 1,
      toolCallId: `fallback:${diagnosis.windowBucket}:${steps.length + 1}:query_decline_mix`,
      toolName: "query_decline_mix",
      toolArgs: { cell: diagnosis.cell, windowMin: mix.windowUsed },
      toolResult: {
        dominantCode: mix.dominantCode,
        referenceSource: mix.referenceSource,
        totalDeclines: mix.totalDeclines,
        shifts: mix.shifts,
      },
      status: "completed",
      errorCode: null,
      decisionTag: "CHECK_DECLINE_MIX",
      decisionSummary: "Checked the decline-code mix shift for diagnostic evidence.",
      hypothesis: null,
      evidenceStepNos: [steps.length],
      createdAt: now,
      completedAt: now,
    });
  }

  return steps;
}

function mapDimension(dimension: Dimension): "merchant" | "provider" | "country" | "payment_method" | "issuer" {
  switch (dimension) {
    case "merchantId":
      return "merchant";
    case "providerId":
      return "provider";
    case "country":
      return "country";
    case "paymentMethod":
      return "payment_method";
    case "issuerId":
      return "issuer";
  }
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
