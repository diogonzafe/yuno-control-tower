import { aggregate, matchesFilter } from "./aggregate.js";
import { MIN_VOLUME } from "./constants.js";
import { crossSectionalExpected } from "./expected.js";
import type { Dimension, MerchantConfig, RollupRow, RoutingCoverage, SliceFilter } from "./types.js";
import { evaluate, type Interval } from "./wilson.js";
export type Candidate = { dimensions: SliceFilter; state: "MATERIAL_DROP" | "INSUFFICIENT_EVIDENCE"; ci: Interval; observedRate: number; expectedRate: number; expectedSource: "absolute" | "cross_sectional" | "temporal"; deltaPp: number; attempts: number; approved: number; windowUsed: "1m" | "5m" };
function roots(rows: RollupRow[]) { return [...new Map(rows.map((r) => [`${r.merchantId}|${r.country}`, { merchantId: r.merchantId, country: r.country }])).values()]; }
function candidate(filter: SliceFilter, agg: ReturnType<typeof aggregate>, expectedRate: number, deltaPp: number, expectedSource: Candidate["expectedSource"]): Candidate | null {
  const { state, ci } = evaluate(agg.approved, agg.attempts, expectedRate, deltaPp, MIN_VOLUME);
  return state === "MATERIAL_DROP" || state === "INSUFFICIENT_EVIDENCE" ? { dimensions: filter, state, ci, observedRate: agg.rate ?? 0, expectedRate, expectedSource, deltaPp, attempts: agg.attempts, approved: agg.approved, windowUsed: "1m" } : null;
}
export function absoluteTrigger(rows: RollupRow[], merchants: MerchantConfig[]): Candidate[] { const configs = new Map(merchants.map((m) => [m.merchantId, m])); return roots(rows).flatMap((root) => { const m = configs.get(root.merchantId); if (!m) return []; const c = candidate(root, aggregate(rows, { filter: root }), m.expectedConversion, m.minMaterialDropPp, "absolute"); return c ? [c] : []; }); }
function childValues(rows: RollupRow[], coverage: RoutingCoverage, parent: SliceFilter, dim: Dimension): string[] {
  const present = [...new Set(rows.filter((r) => matchesFilter(r, parent)).map((r) => r[dim]))];
  if (dim === "issuerId") return present;
  const covered = new Set(coverage.filter((c) => c.country === parent.country).map((c) => dim === "providerId" ? c.providerId : c.paymentMethod));
  return present.filter((v) => covered.has(v));
}
export function crossSectionalSweep(rows: RollupRow[], coverage: RoutingCoverage, merchants: MerchantConfig[]): Candidate[] {
  const configs = new Map(merchants.map((m) => [m.merchantId, m])); const out: Candidate[] = [];
  for (const root of roots(rows)) { const m = configs.get(root.merchantId); if (!m) continue; const splits: Array<{ parent: SliceFilter; dim: Dimension }> = [{ parent: root, dim: "providerId" }, { parent: { ...root, paymentMethod: "CARD" }, dim: "issuerId" }]; if (root.country === "BR") splits.push({ parent: root, dim: "paymentMethod" });
    for (const { parent, dim } of splits) for (const value of childValues(rows, coverage, parent, dim)) { const values = childValues(rows, coverage, parent, dim); if (values.length < 2) break; const expected = crossSectionalExpected(rows, parent, dim, value); if (expected === null) continue; const filter = { ...parent, [dim]: value } as SliceFilter; const c = candidate(filter, aggregate(rows, { filter }), expected, m.minMaterialDropPp, "cross_sectional"); if (c) out.push(c); }
  } return out;
}
