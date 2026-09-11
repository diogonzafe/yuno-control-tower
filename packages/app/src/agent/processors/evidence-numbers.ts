import type { Processor, ProcessOutputResultArgs } from "@mastra/core/processors";
import type { NarrationInput } from "@control-tower/contracts";

const MAX_RETRIES = 2;

/**
 * RequestContext key narrator.ts writes the parsed NarrationInput under and
 * agents/narrator.ts's outputProcessors reads it back from, so each request
 * gets an EvidenceNumbersProcessor closed over that request's own evidence
 * object instead of one shared across concurrent renders.
 */
export const NARRATION_INPUT_KEY = "narration-input";

function collectAllowedNumbers(value: unknown, collector: Set<string>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    collector.add(value.toString());
    // A rate is stored as 0.12 but read aloud as "12%". Admitting the
    // percentage form is not a loophole — the number still has to come from a
    // field of the evidence object; it just may be spoken the way an operator
    // speaks it. Without this every readable narrative would be rejected and
    // fall back to the template, defeating spec.md §4 criterion 4.
    if (value >= 0 && value <= 1) {
      const asPercent = value * 100;
      collector.add(asPercent.toString());
      collector.add(Math.round(asPercent).toString());
      collector.add(asPercent.toFixed(1));
    }
    return;
  }

  if (typeof value === "string") {
    const matches = value.match(/-?\d+(?:\.\d+)?/g) ?? [];
    for (const match of matches) {
      collector.add(match);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAllowedNumbers(item, collector);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectAllowedNumbers(nested, collector);
    }
  }
}

/**
 * Boundary #2 (rules.md §3): the narrator never calculates — every number it
 * prints must come literally from a field of the closed evidence object.
 *
 * Lives here rather than in narrator.ts so EvidenceNumbersProcessor can
 * depend on it without creating a cycle: narrator.ts -> mastra.ts ->
 * agents/narrator.ts -> this module -> narrator.ts. narrator.ts re-exports
 * this symbol so narrator.test.ts's six tests keep passing unchanged.
 */
export function assertNarrativeUsesOnlyEvidenceNumbers(
  text: string,
  input: NarrationInput,
): void {
  const allowedNumbers = new Set<string>();
  collectAllowedNumbers(input, allowedNumbers);

  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  for (const match of matches) {
    if (!allowedNumbers.has(match)) {
      throw new Error(`Narrative introduced a number not present in the evidence object: ${match}`);
    }
  }
}

/**
 * Boundary #2, enforced inside the framework pipeline.
 *
 * The check itself is unchanged — every number printed must appear in the
 * closed evidence object. What changes is that a violation is now a visible
 * event in the trace, instead of an exception swallowed by a bare catch that
 * silently served the template.
 *
 * `retry: args.retryCount < MAX_RETRIES` below signals a retry is wanted, but
 * nothing currently sets `maxProcessorRetries` on the agent, and per Mastra's
 * own docs `retry: true` and `retry: false` are indistinguishable without
 * it — the call resolves with a tripwire either way, on the first violation.
 * The signal is in place but inert; wiring `maxProcessorRetries` would be a
 * behaviour change this phase does not permit (spec.md §4).
 *
 * `abort()` throws synchronously (it is typed to return `never`), so a
 * violation turns this method's promise into a rejection. That rejection
 * does NOT propagate out of Agent.generate() — measured against the
 * installed @mastra/core@1.37.1, the outer call resolves normally with
 * `tripwire` set and `object`/`text` still carrying the violating output.
 * narrator.ts's render() is what turns a tripped wire back into a thrown
 * error so the primary -> reserve -> template cascade still fires; this
 * class only has to guarantee it always calls abort() on a violation.
 */
export class EvidenceNumbersProcessor implements Processor {
  readonly id = "evidence-numbers";

  constructor(private readonly input: NarrationInput) {}

  async processOutputResult(args: ProcessOutputResultArgs) {
    try {
      assertNarrativeUsesOnlyEvidenceNumbers(args.result.text, this.input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Narrative introduced an unknown number";
      args.abort(reason, { retry: args.retryCount < MAX_RETRIES });
    }

    return args.messages;
  }
}
