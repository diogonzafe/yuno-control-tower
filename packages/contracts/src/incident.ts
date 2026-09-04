import { z } from "zod";
import { ConfirmedDrop, Dimensions, EvidenceGap, ExpectedSource, Interval } from "./detection.js";
import { InvestigationAuditStep } from "./investigation.js";

export { CellState, ConfirmedDrop, Dimensions, EvidenceGap, ExpectedSource, Interval } from "./detection.js";

// One decline code's share of the cell's declines, now vs. its baseline share.
// The signal is the SHIFT, never the presence (context/schema.md §8).
export const DeclineMixEntry = z.object({ code: z.string(), family: z.string(), observedShare: z.number(), baselineShare: z.number(), count: z.number().int() });
export type DeclineMixEntry = z.infer<typeof DeclineMixEntry>;

// A slice that looked anomalous but whose deficit disappeared once the causal
// cell was excluded — the residual test's echo suppression (roadmap §2).
export const SuppressedEcho = z.object({ dimensions: Dimensions, observedRate: z.number(), residualRate: z.number() });
export type SuppressedEcho = z.infer<typeof SuppressedEcho>;

// CONFIRMED: the peeling isolated a causal cell and the residual test kept it.
// INCONCLUSIVE: the root is materially down but no child separated from its
// siblings, so the system reports the drop without naming a culprit rather
// than promoting the least innocent cell (spec.md §5).
export const DiagnosisConfidence = z.enum(["CONFIRMED", "INCONCLUSIVE"]);
export type DiagnosisConfidence = z.infer<typeof DiagnosisConfidence>;

/**
 * The closed evidence object: every number the narrator is allowed to say.
 *
 * Assembled ONLY by diagnose/evidence.ts, deterministically — never by the
 * agent (rules.md §3 fronteira #3: the fallback path must produce the same
 * object without an LLM, so a second assembly path would be duplicated logic).
 * `orchestrate/` persists it verbatim into `incidents.evidence`; the narrator
 * consumes it and may not introduce a number absent from it (fronteira #2).
 */
export const EvidenceObject = z.object({
  fingerprint: z.string(),
  // Where: the causal cell the residual test kept, not the echoes it dropped.
  dimensions: Dimensions,
  // What: the drop itself, carried over from the detector's ConfirmedDrop.
  observedRate: z.number(), expectedRate: z.number(), expectedSource: ExpectedSource, deltaPp: z.number(),
  ci: Interval, attempts: z.number().int(), approved: z.number().int(),
  windowBucket: z.string().datetime(), windowUsed: z.enum(["1m", "5m"]), consecutiveWindows: z.number().int(),
  // Since when: DD8 retroactive scan, never an estimate.
  startedAt: z.string().datetime(), startedAtExact: z.boolean(),
  // Why the system believes it: decline-mix shift + what was ruled out as echo.
  declineMix: z.array(DeclineMixEntry), dominantDecline: z.string().nullable(), suppressedEchoes: z.array(SuppressedEcho),
  // How much: computed from the interval's conservative edge, so it is a floor (DD11).
  lostApprovals: z.number().int(), costUsdMinor: z.number().int(), costUsdPerMin: z.number().int(),
  costLocal: z.record(z.number().int()), priorityScore: z.number(),
  // How it was reached — proves the deterministic fallback actually ran when the agent didn't.
  diagnosisSource: z.enum(["agent", "beam_search"]),
  // Whether the drill-down named a causal cell or stopped at the root because
  // no child separated from its siblings. Without it a bare detection is
  // indistinguishable from a full diagnosis once it reaches the dashboard.
  // Optional only for reading back rows written before the field existed
  // (db/queries.ts re-parses stored evidence); diagnose/evidence.ts is the
  // single assembly point and always sets it, so nothing new can omit it.
  confidence: DiagnosisConfidence.optional(),
  investigationTrail: z.array(InvestigationAuditStep),
});
export type EvidenceObject = z.infer<typeof EvidenceObject>;
