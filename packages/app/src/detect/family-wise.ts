import { Z } from "./constants.js";

// The family-wise error rate the detector is held to across one window. Chosen
// so that `familyWiseZ(1)` reproduces DD11's z = 1.96 exactly: the locked value
// becomes the single-hypothesis case of this rule rather than a separate one.
const FAMILY_ALPHA = 0.05;

/**
 * Inverse standard normal CDF — Acklam's rational approximation, |error| < 1.15e-9.
 *
 * Deterministic and dependency-free, which rules.md §3 requires of everything on
 * the numeric path. A lookup table was the alternative and was discarded: the
 * hypothesis count changes with the shape of the traffic, so the z it needs is
 * not known in advance.
 */
function inverseNormalCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5, r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/**
 * The z a Wilson interval needs when `hypotheses` slices are tested together.
 *
 * `spec.md` §8 question 3, answered: Šidák, because the alternative was to keep
 * testing every slice of the cube at 95% and accept the false positives that
 * follow arithmetically. On 2026-09-10 the sweep tested 69 slices a minute — near
 * 99k tests a day — and produced a few confirmed drops an hour on cells that were
 * healthy over any window wide enough to read, purely because an issuer slice
 * carries 11-24 attempts in a minute.
 *
 * Šidák over Bonferroni only because it is exact for independent tests and no
 * more expensive; at these counts the two differ in the third decimal. The
 * slices are not independent — a provider slice contains its issuer slices — so
 * both are conservative here, which is the direction to err in.
 *
 * What it deliberately does not touch: `diagnose/beam-search.ts` runs its own
 * evaluate over the cube, but it only ever runs on a signal the detector already
 * confirmed, and its job is to localise a fault rather than to decide whether
 * one exists. Correcting a search for the best explanation is a different
 * question from correcting a decision to alert.
 */
export function familyWiseZ(hypotheses: number): number {
  if (!Number.isFinite(hypotheses) || hypotheses < 1) return Z;
  const perTest = 1 - Math.pow(1 - FAMILY_ALPHA, 1 / hypotheses);
  return inverseNormalCdf(1 - perTest / 2);
}
