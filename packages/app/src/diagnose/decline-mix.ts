import { matchesFilter } from "../detect/aggregate.js";
import type { SliceFilter } from "../detect/types.js";
import { DECLINE_WINDOWS_MIN, MIN_DECLINES, TEMPORAL_MIN_DECLINES } from "./constants.js";
import type { DeclineCode, DeclineFamily, DeclineRollupRow } from "./types.js";

export type MixShift = {
  code: string;
  family: DeclineFamily;
  diagnostic: boolean;
  count: number;
  observedShare: number;
  referenceShare: number;
  deltaPp: number;
};

export type DeclineMix = {
  totalDeclines: number;
  windowUsed: number;
  referenceSource: "catalog" | "temporal";
  shifts: MixShift[];
  dominantCode: string | null;
};

export type OutageAttribution = "PROVIDER" | "ISSUER" | "RAIL" | "INCONCLUSIVE";

function inWindow(
  declines: DeclineRollupRow[],
  cell: SliceFilter,
  bucket: string,
  minutes: number,
): DeclineRollupRow[] {
  const from = new Date(new Date(bucket).getTime() - (minutes - 1) * 60_000).toISOString();
  return declines.filter((row) => matchesFilter(row, cell) && row.bucket >= from && row.bucket <= bucket);
}

const total = (rows: DeclineRollupRow[]) => rows.reduce((sum, row) => sum + row.count, 0);

// The catalogue baseline is the default reference: it needs no warm-up, which
// is the same argument DD7 already accepted for expected conversion. The cell's
// own history takes over only once it is thick enough to be the better
// estimate, because a legitimately different mixture per country or issuer
// would otherwise read as a permanent shift.
function temporalShares(history: DeclineRollupRow[], cell: SliceFilter): Map<string, number> | null {
  const rows = history.filter((row) => matchesFilter(row, cell));
  const totalHistory = total(rows);
  if (totalHistory < TEMPORAL_MIN_DECLINES) return null;
  const shares = new Map<string, number>();
  for (const row of rows) shares.set(row.declineCode, (shares.get(row.declineCode) ?? 0) + row.count);
  for (const [code, count] of shares) shares.set(code, count / totalHistory);
  return shares;
}

// The signal is never the presence of a code, it is the move in its share
// (schema.md §8): 05 lives at 32% of declines, and the incident is when it
// becomes 78%.
export function declineMixShift(
  declines: DeclineRollupRow[],
  cell: SliceFilter,
  bucket: string,
  catalog: DeclineCode[],
  history: DeclineRollupRow[] = [],
): DeclineMix {
  let rows: DeclineRollupRow[] = [];
  let windowUsed: number = DECLINE_WINDOWS_MIN[0];
  for (const minutes of DECLINE_WINDOWS_MIN) {
    rows = inWindow(declines, cell, bucket, minutes);
    windowUsed = minutes;
    if (total(rows) >= MIN_DECLINES) break;
  }

  const totalDeclines = total(rows);
  const counted = new Map<string, number>();
  for (const row of rows) counted.set(row.declineCode, (counted.get(row.declineCode) ?? 0) + row.count);

  const temporal = temporalShares(history, cell);
  const shifts: MixShift[] = [];
  for (const [code, count] of counted) {
    const entry = catalog.find((item) => item.code === code);
    if (entry === undefined) continue;
    const observedShare = totalDeclines === 0 ? 0 : count / totalDeclines;
    const referenceShare = temporal === null ? entry.baselineShare : (temporal.get(code) ?? 0);
    shifts.push({
      code,
      family: entry.family,
      diagnostic: entry.diagnostic,
      count,
      observedShare,
      referenceShare,
      deltaPp: (observedShare - referenceShare) * 100,
    });
  }
  shifts.sort((a, b) => b.deltaPp - a.deltaPp || a.code.localeCompare(b.code));

  const dominant = shifts.find((shift) => shift.diagnostic && shift.deltaPp > 0);
  return {
    totalDeclines,
    windowUsed,
    referenceSource: temporal === null ? "catalog" : "temporal",
    shifts,
    dominantCode: dominant?.code ?? null,
  };
}

// 91 is the only code in the catalogue that supports two opposite diagnoses:
// whoever failed to reach the issuer may be the issuer or the provider. The
// spread decides, not the code (schema.md §8). AB03 rides a single rail, so
// spread across providers means the rail itself, and nobody in the system is
// at fault.
export function disambiguateOutage(
  declines: DeclineRollupRow[],
  scope: SliceFilter,
  code: string,
): OutageAttribution {
  const rows = declines.filter(
    (row) => matchesFilter(row, scope) && row.declineCode === code && row.count > 0,
  );
  if (rows.length === 0) return "INCONCLUSIVE";

  const providers = new Set(rows.map((row) => row.providerId));
  const issuers = new Set(rows.filter((row) => row.issuerId !== "NA").map((row) => row.issuerId));

  if (rows.every((row) => row.paymentMethod === "PIX")) {
    return providers.size >= 2 ? "RAIL" : "INCONCLUSIVE";
  }
  if (providers.size === 1 && issuers.size >= 2) return "PROVIDER";
  if (issuers.size === 1 && providers.size >= 2) return "ISSUER";
  return "INCONCLUSIVE";
}
