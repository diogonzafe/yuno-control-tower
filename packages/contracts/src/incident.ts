import { z } from "zod";

export const CellState = z.enum(["MATERIAL_DROP", "HEALTHY", "MONITORING", "INSUFFICIENT_EVIDENCE"]);
export type CellState = z.infer<typeof CellState>;
export const Dimensions = z.object({ merchantId: z.string(), providerId: z.string(), country: z.enum(["BR", "MX", "AR"]), paymentMethod: z.enum(["CARD", "PIX"]), issuerId: z.string() }).partial();
export type Dimensions = z.infer<typeof Dimensions>;
export const ExpectedSource = z.enum(["cross_sectional", "temporal", "absolute"]);
export type ExpectedSource = z.infer<typeof ExpectedSource>;
export const ConfirmedDrop = z.object({
  dimensions: Dimensions, windowBucket: z.string().datetime(), observedRate: z.number(), expectedRate: z.number(), expectedSource: ExpectedSource, deltaPp: z.number(), ciLow: z.number(), ciHigh: z.number(), ciLevel: z.number(), attempts: z.number().int(), approved: z.number().int(), windowUsed: z.enum(["1m", "5m"]), startedAt: z.string().datetime(), startedAtExact: z.boolean(), consecutiveWindows: z.number().int(),
});
export type ConfirmedDrop = z.infer<typeof ConfirmedDrop>;
export const EvidenceGap = z.object({ dimensions: Dimensions, windowBucket: z.string().datetime(), attempts: z.number().int(), reason: z.literal("INSUFFICIENT_EVIDENCE") });
export type EvidenceGap = z.infer<typeof EvidenceGap>;

export const Interval = z.object({ low: z.number(), high: z.number(), level: z.number() });
export type Interval = z.infer<typeof Interval>;

// One decline code's share of the cell's declines, now vs. its baseline share.
// The signal is the SHIFT, never the presence (context/schema.md §8).
export const DeclineMixEntry = z.object({ code: z.string(), family: z.string(), observedShare: z.number(), baselineShare: z.number(), count: z.number().int() });
export type DeclineMixEntry = z.infer<typeof DeclineMixEntry>;

// A slice that looked anomalous but whose deficit disappeared once the causal
// cell was excluded — the residual test's echo suppression (roadmap §2).
export const SuppressedEcho = z.object({ dimensions: Dimensions, observedRate: z.number(), residualRate: z.number() });
export type SuppressedEcho = z.infer<typeof SuppressedEcho>;

export const InvestigationStep = z.object({ stepNo: z.number().int(), actor: z.enum(["agent", "fallback"]), toolName: z.string(), toolArgs: z.record(z.unknown()), toolResult: z.record(z.unknown()), reasoning: z.string().nullable() });
export type InvestigationStep = z.infer<typeof InvestigationStep>;

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
  investigationTrail: z.array(InvestigationStep),
});
export type EvidenceObject = z.infer<typeof EvidenceObject>;
