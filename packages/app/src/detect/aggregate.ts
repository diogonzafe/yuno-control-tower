import type { RollupRow, SliceFilter } from "./types.js";
export type AggResult = { attempts: number; approved: number; amountUsdSum: number; approvedUsdSum: number; rate: number | null };
export function matchesFilter(row: RollupRow, filter?: SliceFilter): boolean {
  return !filter || Object.entries(filter).every(([key, value]) => row[key as keyof SliceFilter] === value);
}
export function aggregate(rows: RollupRow[], opts: { filter?: SliceFilter; exclude?: SliceFilter } = {}): AggResult {
  const total = rows.filter((r) => matchesFilter(r, opts.filter) && (!opts.exclude || !matchesFilter(r, opts.exclude))).reduce((a, r) => ({ attempts: a.attempts + r.attempts, approved: a.approved + r.approved, amountUsdSum: a.amountUsdSum + r.amountUsdSum, approvedUsdSum: a.approvedUsdSum + r.approvedUsdSum }), { attempts: 0, approved: 0, amountUsdSum: 0, approvedUsdSum: 0 });
  return { ...total, rate: total.attempts === 0 ? null : total.approved / total.attempts };
}
export function aggregateByBucket(rows: RollupRow[], opts: { filter?: SliceFilter } = {}): Array<AggResult & { bucket: string }> {
  return [...new Set(rows.map((r) => r.bucket))].sort().map((bucket) => ({ bucket, ...aggregate(rows.filter((r) => r.bucket === bucket), opts) }));
}
