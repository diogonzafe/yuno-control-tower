import { describe, expect, it } from "vitest";
import { Z, MIN_VOLUME } from "./constants.js";
import { familyWiseZ } from "./family-wise.js";
import { evaluate } from "./wilson.js";

/**
 * `spec.md` §8 question 3 — controlling multiple comparisons — measured.
 *
 * The detector tests every slice of the cube in every window, all at the same
 * fixed 95% level. On 2026-09-10 that was 69 slices a minute, about 99k tests a
 * day, and a few false MATERIAL_DROPs an hour is the arithmetic consequence, not
 * a bug in any one of them. BR_STORE_02 produced one that night: three issuer
 * slices sitting at 0.897/0.898/0.902 over three hours, all healthy, but each
 * carrying only 11-24 attempts a minute, so a single window read 0.868 against
 * siblings at 0.973 and confirmed.
 */
describe("family-wise correction", () => {
  it("is exactly DD11's z when only one hypothesis is tested", () => {
    // The family alpha stays 0.05 two-sided, so a single test is unchanged and
    // DD11's locked value is the m = 1 case of this formula rather than a
    // separate rule.
    expect(familyWiseZ(1)).toBeCloseTo(Z, 3);
  });

  it("widens as the cube grows, never narrows", () => {
    const zs = [1, 8, 24, 69, 129].map(familyWiseZ);
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
    expect(familyWiseZ(69)).toBeCloseTo(3.37, 1);
  });

  it("treats a degenerate count as a single test", () => {
    expect(familyWiseZ(0)).toBeCloseTo(Z, 3);
    expect(familyWiseZ(-3)).toBeCloseTo(Z, 3);
  });

  // The two readings that decide whether this is worth doing, both taken from
  // production rather than invented.
  const noise = { k: 79, n: 91, expected: 0.973 };      // BR_STORE_02, healthy
  const real = { k: 4, n: 45, expected: 0.9 };          // stripe x itau, injected

  it("silences the thin healthy slice that fired at 95%", () => {
    expect(evaluate(noise.k, noise.n, noise.expected, 3, MIN_VOLUME).state).toBe("MATERIAL_DROP");
    expect(
      evaluate(noise.k, noise.n, noise.expected, 3, MIN_VOLUME, familyWiseZ(69)).state,
    ).not.toBe("MATERIAL_DROP");
  });

  it("still confirms a real fault, which is nowhere near the boundary", () => {
    // 0.089 against a 0.87 limit: the correction moves the bound by a few
    // hundredths, and this drop clears it by more than sixty points.
    expect(evaluate(real.k, real.n, real.expected, 3, MIN_VOLUME).state).toBe("MATERIAL_DROP");
    expect(
      evaluate(real.k, real.n, real.expected, 3, MIN_VOLUME, familyWiseZ(69)).state,
    ).toBe("MATERIAL_DROP");
  });

  it("keeps a recovered cell readable as HEALTHY rather than merely ambiguous", () => {
    // A wider interval makes HEALTHY harder to claim too, and persistence.step
    // needs an explicit non-drop verdict to clear a streak. A well-evidenced
    // recovery must survive the correction or an incident would never resolve.
    expect(evaluate(950, 1000, 0.9, 3, MIN_VOLUME, familyWiseZ(69)).state).toBe("HEALTHY");
  });
});
