import {
  EvidenceObject,
  type DeclineMixEntry,
  type Dimensions,
  type InvestigationStep,
  type SuppressedEcho,
} from "@control-tower/contracts";
import type { RollupRow } from "../detect/types.js";
import { cellKey } from "./beam-search.js";
import type { Echo } from "./peeling.js";
import type { Diagnosis } from "./run.js";
import { buildTrail } from "./trail.js";

export type BuildEvidenceInput = {
  diagnosis: Diagnosis;
  rows: RollupRow[];
  diagnosisSource: "agent" | "beam_search";
  // The agent path supplies the trail it actually walked; the deterministic
  // path leaves it out and gets the replay from trail.ts.
  investigationTrail?: InvestigationStep[];
};

/**
 * The single assembly point for the closed evidence object.
 *
 * Everything here is translation, not computation: each number was already
 * decided by the detector, the peeling loop or the cost estimate, and this
 * function only renames, rounds and reshapes them into the contract the
 * narrator and `orchestrate/` consume. Keeping it that way is what lets the
 * agent and the fallback produce the same object (rules.md §3, fronteira #3) —
 * a second place that computed anything would let the two paths disagree.
 */
export function buildEvidence(input: BuildEvidenceInput): EvidenceObject {
  const { diagnosis, rows, diagnosisSource } = input;
  const dominantDecline = diagnosis.declineMix?.dominantCode ?? null;

  return EvidenceObject.parse({
    fingerprint: fingerprintOf(diagnosis, dominantDecline),
    dimensions: diagnosis.cell as Dimensions,

    observedRate: diagnosis.observedRate,
    expectedRate: diagnosis.expectedRate,
    expectedSource: diagnosis.expectedSource,
    deltaPp: diagnosis.deltaPp,
    ci: { low: diagnosis.ci.low, high: diagnosis.ci.high, level: diagnosis.ciLevel },
    attempts: diagnosis.attempts,
    approved: diagnosis.approved,
    windowBucket: diagnosis.windowBucket,
    windowUsed: diagnosis.windowUsed,
    consecutiveWindows: diagnosis.consecutiveWindows,

    startedAt: diagnosis.startedAt,
    startedAtExact: diagnosis.startedAtExact,

    declineMix: mixEntries(diagnosis),
    dominantDecline,
    suppressedEchoes: diagnosis.suppressedEchoes.flatMap(toContractEcho),

    lostApprovals: diagnosis.impact.lostApprovals,
    costUsdMinor: Math.round(diagnosis.impact.costUsdMinor),
    // Minor units are indivisible, and the executive line reads this figure
    // straight: dividing by the elapsed minutes leaves a fraction of a cent
    // that the contract's integer column has no room for.
    costUsdPerMin: Math.round(diagnosis.impact.costUsdPerMin),
    costLocal: diagnosis.impact.costLocal,
    priorityScore: diagnosis.impact.priorityScore,

    diagnosisSource,
    investigationTrail: input.investigationTrail ?? buildTrail(rows, diagnosis),
  });
}

// The dimensions alone name the place; the dominant code names the failure
// happening there. Both belong in the key, so the same cell breaking a second
// time for a different reason opens a new incident instead of quietly
// updating the old one (incidents.fingerprint, db/schema.ts).
function fingerprintOf(diagnosis: Diagnosis, dominantDecline: string | null): string {
  const cell = cellKey(diagnosis.cell);
  return dominantDecline === null ? cell : `${cell}#${dominantDecline}`;
}

// MixShift carries two fields the narrator has no use for — `diagnostic` and
// `deltaPp` — and calls the comparison point `referenceShare` because it may
// come from the cell's own history rather than the catalogue. The contract
// only exposes the pair of shares, so the shift stays readable either way.
function mixEntries(diagnosis: Diagnosis): DeclineMixEntry[] {
  return (diagnosis.declineMix?.shifts ?? []).map((shift) => ({
    code: shift.code,
    family: shift.family,
    observedShare: shift.observedShare,
    baselineShare: shift.referenceShare,
    count: shift.count,
  }));
}

// An echo with no residual is a fragment the cause swallowed whole, not a
// slice the residual test cleared. There is no second rate to show next to
// the first, so it is not evidence of anything and does not travel.
function toContractEcho(echo: Echo): SuppressedEcho[] {
  if (echo.residualRate === null) return [];
  return [
    {
      dimensions: echo.cell as Dimensions,
      observedRate: echo.observedRate,
      residualRate: echo.residualRate,
    },
  ];
}
