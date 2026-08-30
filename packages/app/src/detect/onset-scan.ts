import { aggregateByBucket } from "./aggregate.js";
import { MIN_VOLUME, ONSET_LOOKBACK_MIN, PERSISTENCE_WINDOWS } from "./constants.js";
import type { RollupRow, SliceFilter } from "./types.js";
function minusMinutes(iso: string, minutes: number) { return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString(); }
export function onsetScan(series: RollupRow[], filter: SliceFilter, detectionBucket: string, expectedRate: number, deltaPp: number): { startedAt: string; startedAtExact: boolean } {
  const limit = expectedRate - deltaPp / 100, from = minusMinutes(detectionBucket, ONSET_LOOKBACK_MIN);
  const buckets = aggregateByBucket(series.filter((r) => r.bucket >= from && r.bucket <= detectionBucket), { filter });
  let start = -1, inexact = false;
  for (let i = buckets.length - 1; i >= 0; i--) { const b = buckets[i]!; if (b.attempts >= MIN_VOLUME && b.rate !== null && b.rate >= limit) break; if (b.attempts < MIN_VOLUME) inexact = true; start = i; }
  return start < 0 || buckets.length - start < PERSISTENCE_WINDOWS ? { startedAt: detectionBucket, startedAtExact: false } : { startedAt: buckets[start]!.bucket, startedAtExact: !inexact };
}
