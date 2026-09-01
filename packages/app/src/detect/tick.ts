import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import { aggregate, matchesFilter } from "./aggregate.js";
import { MIN_VOLUME, THIN_CELL_WINDOW_MIN } from "./constants.js";
import { onsetScan } from "./onset-scan.js";
import { fingerprint, step, type PersistenceState } from "./persistence.js";
import { absoluteTrigger, crossSectionalSweep, type Candidate } from "./trigger.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "./types.js";
import { evaluate } from "./wilson.js";
export type TickInput = { bucket: string; windowRows: RollupRow[]; history: RollupRow[]; merchants: MerchantConfig[]; coverage: RoutingCoverage; prevState: PersistenceState; persistenceWindows?: number };
export type TickOutput = { signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[]; nextState: PersistenceState };
function minusMinutes(iso: string, n: number) { return new Date(new Date(iso).getTime() - n * 60_000).toISOString(); }
function preferred(a: Candidate, b: Candidate) { if (a.state !== b.state) return a.state === "MATERIAL_DROP" ? a : b; return a.expectedSource === "cross_sectional" ? a : b; }
function dedupe(candidates: Candidate[]) { const map = new Map<string, Candidate>(); for (const c of candidates) { const previous = map.get(fingerprint(c.dimensions)); map.set(fingerprint(c.dimensions), previous ? preferred(previous, c) : c); } return [...map.values()]; }
function gap(c: Candidate, bucket: string, attempts = c.attempts): EvidenceGap { return { dimensions: c.dimensions as EvidenceGap["dimensions"], windowBucket: bucket, attempts, reason: "INSUFFICIENT_EVIDENCE" }; }
function retry(c: Candidate, input: TickInput): Candidate | EvidenceGap { const from = minusMinutes(input.bucket, THIN_CELL_WINDOW_MIN - 1); const agg = aggregate([...input.history.filter((r) => r.bucket >= from && r.bucket < input.bucket), ...input.windowRows].filter((r) => matchesFilter(r, c.dimensions))); const result = evaluate(agg.approved, agg.attempts, c.expectedRate, c.deltaPp, MIN_VOLUME); return result.state === "MATERIAL_DROP" && agg.attempts >= MIN_VOLUME ? { ...c, ci: result.ci, observedRate: agg.rate ?? 0, attempts: agg.attempts, approved: agg.approved, windowUsed: "5m" } : gap(c, input.bucket, agg.attempts); }
export function runDetectionTick(input: TickInput): TickOutput {
  const raw = dedupe([...absoluteTrigger(input.windowRows, input.merchants), ...crossSectionalSweep(input.windowRows, input.coverage, input.merchants)]), candidates: Candidate[] = [], gaps: EvidenceGap[] = [];
  for (const c of raw) { if (c.state === "INSUFFICIENT_EVIDENCE") gaps.push(gap(c, input.bucket)); else if (c.attempts >= MIN_VOLUME) candidates.push(c); else { const result = retry(c, input); if ("reason" in result) gaps.push(result); else candidates.push(result); } }
  const { promoted, next } = step(candidates, input.prevState, input.bucket, input.persistenceWindows); const series = [...input.history, ...input.windowRows];
  const signals: ConfirmedDrop[] = promoted.map((c) => { const onset = onsetScan(series, c.dimensions, input.bucket, c.expectedRate, c.deltaPp), entry = next.get(fingerprint(c.dimensions))!; return { dimensions: c.dimensions as ConfirmedDrop["dimensions"], windowBucket: input.bucket, observedRate: c.observedRate, expectedRate: c.expectedRate, expectedSource: c.expectedSource, deltaPp: c.deltaPp, ciLow: c.ci.low, ciHigh: c.ci.high, ciLevel: 0.95, attempts: c.attempts, approved: c.approved, windowUsed: c.windowUsed, ...onset, consecutiveWindows: entry.count }; });
  return { signals, evidenceGaps: [...new Map(gaps.map((g) => [fingerprint(g.dimensions), g])).values()], nextState: next };
}
