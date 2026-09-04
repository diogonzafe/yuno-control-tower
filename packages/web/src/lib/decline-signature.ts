// An injected incident that only lowers conversion is under-specified: the
// transactions still fail for whatever reason the baseline mix happens to draw,
// so the dominant decline code is noise that changes from window to window.
// diagnose/evidence.ts keys the incident fingerprint on that code
// (`cell#dominantDecline`, deliberately — "the same cell breaking a second time
// for a different reason opens a new incident"), so an injected fault with no
// signature opens a fresh incident every time the winner changes. We watched one
// injection produce #01, #62, #65 and #91 for the same cell.
//
// Giving the injection a cause fixes that at the source and makes the decline-mix
// panel show a real shift instead of noise. The generator applies these as weight
// overrides per code (generator/src/mix.ts: `overrideWeights[code] ?? weight`),
// and the inject API has always accepted them — only the console never sent any.

// Baseline shares sum to 1.0 across the catalog, so this puts the chosen code at
// roughly three quarters of the cell's declines: dominant enough that the winner
// never flips, low enough that the mix still looks like a shift rather than a
// monoculture.
export const DOMINANT_DECLINE_WEIGHT = 2;

// Codes are the real primary keys of the seeded decline_codes table. A code
// outside the generator's mix is silently ignored by declineCodeFor, so these
// are cross-checked against the label catalog in decline-signature.test.ts.
const PIX_RAIL_TIMEOUT = "AB03";
const ISSUER_DO_NOT_HONOR = "05";
const NETWORK_ISSUER_UNAVAILABLE = "91";

export type InjectedDimensions = {
  paymentMethod?: string;
  providerId?: string;
  issuerId?: string;
};

/**
 * The decline signature a fault on these dimensions would really produce.
 *
 * Picks by the most specific cause the jury fixed: an issuer declines with its
 * own code, a provider that cannot reach the issuer times out on the network,
 * and PIX fails on the rail because it has no issuer at all. A drop with
 * neither still gets one coherent code — its spread across every provider and
 * issuer is what tells diagnose/decline-mix.ts the outage is attributable to
 * neither, which is the honest answer for a platform-wide event.
 */
export function declineSignatureFor(dimensions: InjectedDimensions): Record<string, number> {
  return { [codeFor(dimensions)]: DOMINANT_DECLINE_WEIGHT };
}

function codeFor({ paymentMethod, providerId, issuerId }: InjectedDimensions): string {
  if (paymentMethod === "PIX") return PIX_RAIL_TIMEOUT;
  if (issuerId) return ISSUER_DO_NOT_HONOR;
  if (providerId) return NETWORK_ISSUER_UNAVAILABLE;
  return ISSUER_DO_NOT_HONOR;
}
