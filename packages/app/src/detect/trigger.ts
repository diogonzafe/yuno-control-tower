import type { CellState } from "@control-tower/contracts";
import { aggregate, matchesFilter } from "./aggregate.js";
import { MIN_VOLUME } from "./constants.js";
import { crossSectionalExpected } from "./expected.js";
import type { Dimension, MerchantConfig, RollupRow, RoutingCoverage, SliceFilter } from "./types.js";
import { evaluate, type Interval } from "./wilson.js";
export type Candidate = { dimensions: SliceFilter; state: CellState; ci: Interval; observedRate: number; expectedRate: number; expectedSource: "absolute" | "cross_sectional" | "temporal"; deltaPp: number; attempts: number; approved: number; windowUsed: "1m" | "5m" };
function roots(rows: RollupRow[]) { return [...new Map(rows.map((r) => [`${r.merchantId}|${r.country}`, { merchantId: r.merchantId, country: r.country }])).values()]; }
// Every evaluate() verdict becomes a Candidate — HEALTHY and MONITORING
// included, not just MATERIAL_DROP/INSUFFICIENT_EVIDENCE. persistence.step()
// only resets a fingerprint's streak when it sees an explicit non-drop
// reading for it; a well-evidenced recovery (HEALTHY) or a return to
// statistical ambiguity (MONITORING) that got filtered out here would look
// identical to "no data this tick" to persistence.step(), which carries the
// streak forward instead of clearing it — leaving it stuck as a pending
// signal forever even after the drop has clearly stopped repeating.
function candidate(filter: SliceFilter, agg: ReturnType<typeof aggregate>, expectedRate: number, deltaPp: number, expectedSource: Candidate["expectedSource"]): Candidate {
  const { state, ci } = evaluate(agg.approved, agg.attempts, expectedRate, deltaPp, MIN_VOLUME);
  return { dimensions: filter, state, ci, observedRate: agg.rate ?? 0, expectedRate, expectedSource, deltaPp, attempts: agg.attempts, approved: agg.approved, windowUsed: "1m" };
}
export function absoluteTrigger(rows: RollupRow[], merchants: MerchantConfig[]): Candidate[] { const configs = new Map(merchants.map((m) => [m.merchantId, m])); return roots(rows).flatMap((root) => { const m = configs.get(root.merchantId); if (!m) return []; return [candidate(root, aggregate(rows, { filter: root }), m.expectedConversion, m.minMaterialDropPp, "absolute")]; }); }
function childValues(rows: RollupRow[], coverage: RoutingCoverage, parent: SliceFilter, dim: Dimension): string[] {
  const present = [...new Set(rows.filter((r) => matchesFilter(r, parent)).map((r) => r[dim]))];
  if (dim === "issuerId") return present;
  const covered = new Set(coverage.filter((c) => c.country === parent.country).map((c) => dim === "providerId" ? c.providerId : c.paymentMethod));
  return present.filter((v) => covered.has(v));
}
export function crossSectionalSweep(rows: RollupRow[], coverage: RoutingCoverage, merchants: MerchantConfig[]): Candidate[] {
  const configs = new Map(merchants.map((m) => [m.merchantId, m])); const out: Candidate[] = [];
  for (const root of roots(rows)) { const m = configs.get(root.merchantId); if (!m) continue;
    const providers = childValues(rows, coverage, root, "providerId");
    for (const { parent, dim } of splitsOf(root, providers)) for (const value of childValues(rows, coverage, parent, dim)) { const values = childValues(rows, coverage, parent, dim); if (values.length < 2) break; const expected = crossSectionalExpected(rows, parent, dim, value); if (expected === null) continue; const filter = { ...parent, [dim]: value } as SliceFilter; out.push(candidate(filter, aggregate(rows, { filter }), expected, m.minMaterialDropPp, "cross_sectional")); }
  } return out;
}

/**
 * The slices both sweeps compare a cell against its siblings in.
 *
 * The last group is what lets a fault be seen where it actually lives. A cause
 * confined to one provider's traffic through one issuer is arithmetically
 * invisible in every single-dimension slice: the provider's other issuers lift
 * its average back up, the issuer's other providers do the same, and a second
 * cause elsewhere under the merchant pulls the sibling reference down to meet
 * it. Measured on 2026-09-04 — `adyen x nubank` at ~0.32 against a 0.90
 * baseline, next to a severe `stripe x itau`, read as *better* than expected in
 * both of its own slices (masked-cell.test.ts reproduces the arithmetic).
 *
 * Splitting the issuers inside one provider is the only comparison that puts
 * that cell next to a sibling the fault does not touch. It is where `peel`
 * already ends up on the diagnosis side; the detector simply could not see far
 * enough to hand it the signal.
 */
function splitsOf(root: SliceFilter, providers: string[]): Array<{ parent: SliceFilter; dim: Dimension }> {
  const card = { ...root, paymentMethod: "CARD" } as SliceFilter;
  const splits: Array<{ parent: SliceFilter; dim: Dimension }> = [
    { parent: root, dim: "providerId" },
    { parent: card, dim: "issuerId" },
    ...providers.map((providerId) => ({ parent: { ...card, providerId } as SliceFilter, dim: "issuerId" as Dimension })),
  ];
  if (root.country === "BR") splits.push({ parent: root, dim: "paymentMethod" });
  return splits;
}

/**
 * The third lens: each cell against its own past, not against its siblings.
 *
 * Cross-sectional expectation is drawn from a cell's siblings, so two causes
 * under one merchant each drag the other's reference down until neither reads
 * as material. Production showed it exactly: a severe stripe/itau drop pulled
 * adyen's reference from ~0.886 to ~0.780, leaving a real 0.44 cell only 2.7pp
 * below its own baseline and therefore invisible. A cell's own history does not
 * move when a sibling breaks, so this catches what that masking hides — the
 * `temporal` expectedSource the contract has always allowed and nothing emitted.
 *
 * Rides on the history the tick already loads for the onset scan rather than
 * widening the per-tick read; the agent's own temporal fallback settles for the
 * same window. `MIN_VOLUME` applies to the baseline too: a handful of past
 * attempts is not a baseline worth comparing against.
 */
export function temporalSweep(rows: RollupRow[], history: RollupRow[], coverage: RoutingCoverage, merchants: MerchantConfig[]): Candidate[] {
  const configs = new Map(merchants.map((m) => [m.merchantId, m])); const out: Candidate[] = [];
  for (const root of roots(rows)) { const m = configs.get(root.merchantId); if (!m) continue;
    const providers = childValues(rows, coverage, root, "providerId");
    for (const { parent, dim } of splitsOf(root, providers)) for (const value of childValues(rows, coverage, parent, dim)) {
      const filter = { ...parent, [dim]: value } as SliceFilter;
      const past = aggregate(history, { filter });
      if (past.rate === null || past.attempts < MIN_VOLUME) continue;
      out.push(candidate(filter, aggregate(rows, { filter }), past.rate, m.minMaterialDropPp, "temporal"));
    }
  } return out;
}
