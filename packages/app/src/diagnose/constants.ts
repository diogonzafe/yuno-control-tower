// Beam kept deliberately wide: the cube has 90 cells (DD13), so breadth costs
// nothing and a diluted parent must not crowd out the concentrated child.
export const BEAM_WIDTH = 4;

// DD19: fixing all five dimensions yields a single cell, almost always too
// specific and too thin to defend.
export const MAX_DEPTH = 3;

// Two candidates count as explaining the drop equally well within this relative
// band, which is where concentration and then parsimony decide.
export const SELECTION_TOLERANCE = 0.02;

// DD18: peeling terminates on the residual, not on a count. The cap only stops
// a pathological loop.
export const MAX_INCIDENTS_PER_ROOT = 3;

// Below this a single decline moves a share by more than five points, so the
// shift would be noise rather than signal.
export const MIN_DECLINES = 20;

// schema.md §8: a PIX cell produces roughly three declines a minute, far too
// few to read a mixture from, so the window widens until it can be read.
export const DECLINE_WINDOWS_MIN = [1, 5, 15] as const;

// The cell's own history only replaces the catalogue once it carries enough
// declines to estimate a share more precisely than the published baseline.
export const TEMPORAL_MIN_DECLINES = 100;

// How far back the live wiring fetches "current" declines for declineMixShift
// — wide enough to cover its widest own window (DECLINE_WINDOWS_MIN's 15).
export const DECLINE_CURRENT_LOOKBACK_MIN = 15;

// How far back the live wiring fetches the temporal reference, once a cell
// carries enough declines (TEMPORAL_MIN_DECLINES) to replace the catalogue
// baseline. Six hours is wide enough to accumulate that volume without
// reaching into a different part of the day — the same order of magnitude as
// the detector's own temporal fallback (schema.md §6, "últimas 2–6 horas").
export const DECLINE_HISTORY_LOOKBACK_MIN = 360;

// DD4 locks the three countries, so the local currency of a slice is a lookup,
// never a conversion (DD9 froze the rate on the transaction itself).
export const CURRENCY_BY_COUNTRY: Record<string, string> = { BR: "BRL", MX: "MXN", AR: "ARS" };
