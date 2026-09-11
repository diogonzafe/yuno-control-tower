import { describe, expect, it, vi } from "vitest";
import type { EvidenceObject, NarrationInput } from "@control-tower/contracts";
import type { ProcessOutputResultArgs } from "@mastra/core/processors";
import { EvidenceNumbersProcessor } from "./evidence-numbers.js";

// Same shape narrator.test.ts already exercises, kept local so the processor
// test does not depend on a fixture that phase 3 is going to reshape.
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

/**
 * Shaped after a live probe against the installed @mastra/core@1.37.1: a
 * real Agent.generate() call with structuredOutput wired an output
 * processor and logged what processOutputResult actually received. The
 * accumulated `result.text` carried the full JSON string of the structured
 * object — fabricated numbers included, e.g.
 * `{"operations":"We lost 999 approvals.","executive":"Escalate."}` — so
 * that is what the processor reads. (task-4-report.md has the transcript.)
 * Only the fields the processor touches (result.text, abort, retryCount)
 * are populated here; the rest of ProcessOutputResultArgs is irrelevant to
 * this processor and elided via the cast, same as the messageList/state
 * fields it never looks at.
 */
function resultArgs(text: string) {
  const abort = vi.fn(() => {
    throw new Error("aborted");
  });
  return {
    result: { text, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: "stop", steps: [] },
    messages: [],
    abort,
    retryCount: 0,
  } as never as ProcessOutputResultArgs & { abort: ReturnType<typeof vi.fn> };
}

describe("EvidenceNumbersProcessor (rules.md §3 boundary #2)", () => {
  it("passes a narrative whose every number is in the evidence", async () => {
    const processor = new EvidenceNumbersProcessor(input);
    const args = resultArgs("Conversion fell to 12%, against 70% expected.");
    await processor.processOutputResult(args);
    expect(args.abort).not.toHaveBeenCalled();
  });

  it("asks the model to retry on the first fabricated number", async () => {
    const processor = new EvidenceNumbersProcessor(input);
    const args = resultArgs("We lost 999 approvals.");
    await expect(processor.processOutputResult(args)).rejects.toThrow();
    expect(args.abort).toHaveBeenCalledWith(
      expect.stringContaining("999"),
      expect.objectContaining({ retry: true }),
    );
  });

  it("stops asking for retries once the budget is spent", async () => {
    const processor = new EvidenceNumbersProcessor(input);
    const args = { ...resultArgs("We lost 999 approvals."), retryCount: 2 };
    await expect(processor.processOutputResult(args)).rejects.toThrow();
    expect(args.abort).toHaveBeenCalledWith(
      expect.stringContaining("999"),
      expect.objectContaining({ retry: false }),
    );
  });
});
