import { aggregate } from "../detect/aggregate.js";
import type { RollupRow, SliceFilter } from "../detect/types.js";
import { wilson } from "../detect/wilson.js";
import { CURRENCY_BY_COUNTRY } from "./constants.js";

export type Impact = {
  durationMin: number;
  lostApprovals: number;
  avgTicketUsdMinor: number;
  costUsdMinor: number;
  costLocal: Record<string, number>;
  costUsdPerMin: number;
  priorityScore: number;
};

export function estimateImpact(
  rows: RollupRow[],
  cell: SliceFilter,
  expected: number,
  startedAt: string,
  windowBucket: string,
): Impact {
  const agg = aggregate(
    rows.filter((row) => row.bucket >= startedAt && row.bucket <= windowBucket),
    { filter: cell },
  );
  const durationMin =
    (new Date(windowBucket).getTime() - new Date(startedAt).getTime()) / 60_000 + 1;

  // DD11: the optimistic edge of the interval, not the point estimate, so the
  // figure the executive reads is a floor and never an inflated guess.
  const ci = wilson(agg.approved, agg.attempts);
  const lostApprovals = Math.round(agg.attempts * Math.max(0, expected - ci.high));

  const avgTicketUsdMinor = agg.attempts === 0 ? 0 : Math.round(agg.amountUsdSum / agg.attempts);
  const avgTicketLocalMinor = agg.attempts === 0 ? 0 : Math.round(agg.amountMinorSum / agg.attempts);
  const costUsdMinor = lostApprovals * avgTicketUsdMinor;
  const currency = CURRENCY_BY_COUNTRY[cell.country ?? ""];
  const costUsdPerMin = costUsdMinor / durationMin;

  return {
    durationMin,
    lostApprovals,
    avgTicketUsdMinor,
    costUsdMinor,
    costLocal: currency === undefined ? {} : { [currency]: lostApprovals * avgTicketLocalMinor },
    costUsdPerMin,
    // The conservative edge already discounts uncertainty: a wide interval
    // raises ci.high, attributes fewer losses and therefore ranks lower. That
    // is the whole weighting — there is no separate confidence factor to tune.
    priorityScore: costUsdPerMin,
  };
}
