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
