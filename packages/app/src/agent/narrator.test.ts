import type { EvidenceObject, NarrationInput } from "@control-tower/contracts";
import { describe, expect, it } from "vitest";
import { assertNarrativeUsesOnlyEvidenceNumbers } from "./narrator.js";

const evidence: EvidenceObject = {
  fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#05",
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen", issuerId: "itau" },
  observedRate: 0.12, expectedRate: 0.7, expectedSource: "cross_sectional", deltaPp: 3,
  ci: { low: 0.08, high: 0.17, level: 0.95 }, attempts: 420, approved: 50,
  windowBucket: "2026-08-30T14:06:00.000Z", windowUsed: "1m", consecutiveWindows: 3,
  startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true,
  declineMix: [{ code: "05", family: "issuer", observedShare: 0.78, baselineShare: 0.32, count: 289 }],
  dominantDecline: "05",
  suppressedEchoes: [],
  lostApprovals: 244, costUsdMinor: 380000, costUsdPerMin: 3800,
  costLocal: { BRL: 128400 }, priorityScore: 3800,
  diagnosisSource: "beam_search", investigationTrail: [],
};

const input: NarrationInput = { evidence, recommendation: null };

// rules.md §4, narrator row: "Teste que faz parsing de números no output e
// confere contra o objeto de evidência — este teste é o que garante a
// fronteira #2." Boundary #2 is that the narrator never calculates: any number
// it prints must have come literally from a field of the closed evidence object.
describe("assertNarrativeUsesOnlyEvidenceNumbers (rules.md §3 boundary #2)", () => {
  it("accepts a narrative whose every number appears in the evidence", () => {
    const narrative =
      "Adyen is declining Itau cards in BR since 14:03. 420 attempts, 50 approved. " +
      "Decline 05 now holds 289 of them. Losing at least 3800 USD per minute.";

    expect(() => assertNarrativeUsesOnlyEvidenceNumbers(narrative, input)).not.toThrow();

    // The assertion above is only meaningful if the narrative actually carried
    // numbers — parse them out and confirm each one is genuinely in the evidence.
    const printed = narrative.match(/-?\d+(?:\.\d+)?/g) ?? [];
    expect(printed.length).toBeGreaterThan(0);

    const flat = JSON.stringify(evidence);
    for (const value of printed) {
      expect(flat).toContain(value);
    }
  });

  it("rejects a fabricated count", () => {
    expect(() =>
      assertNarrativeUsesOnlyEvidenceNumbers("We lost 999 approvals.", input),
    ).toThrow(/not present in the evidence/);
  });

  it("rejects a plausible-looking but invented cost", () => {
    // 3801 is one off from the real costUsdPerMin — the kind of drift a model
    // produces when it rounds or recomputes instead of quoting.
    expect(() =>
      assertNarrativeUsesOnlyEvidenceNumbers("Losing 3801 USD per minute.", input),
    ).toThrow(/3801/);
  });

  it("accepts a rate written as a percentage", () => {
    // observedRate is 0.12 in the object; operations reads "12%". Rejecting the
    // human form would push every LLM narrative to the template fallback and
    // defeat spec.md §4 criterion 4 ("explicação legível").
    expect(() =>
      assertNarrativeUsesOnlyEvidenceNumbers("Conversion fell to 12%, against 70% expected.", input),
    ).not.toThrow();
  });

  it("still rejects a percentage that matches no rate", () => {
    expect(() =>
      assertNarrativeUsesOnlyEvidenceNumbers("Conversion fell to 41%.", input),
    ).toThrow(/41/);
  });

  it("accepts a narrative with no numbers at all", () => {
    expect(() =>
      assertNarrativeUsesOnlyEvidenceNumbers("Adyen is declining Itau cards in Brazil.", input),
    ).not.toThrow();
  });
});
