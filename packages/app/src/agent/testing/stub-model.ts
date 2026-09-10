import type { MastraModelConfig } from "@mastra/core/llm";

export type StubResponse = {
  text?: string;
  object?: unknown;
  toolCalls?: Array<{ toolName: string; args: unknown }>;
};

type StubContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

function toContent(response: StubResponse): StubContentPart[] {
  const parts: StubContentPart[] = [];
  if (response.object !== undefined) {
    parts.push({ type: "text", text: JSON.stringify(response.object) });
  } else if (response.text !== undefined) {
    parts.push({ type: "text", text: response.text });
  }
  (response.toolCalls ?? []).forEach((toolCall, index) => {
    parts.push({
      type: "tool-call",
      toolCallId: `stub-tool-call-${index}`,
      toolName: toolCall.toolName,
      input: JSON.stringify(toolCall.args),
    });
  });
  return parts;
}

/**
 * A LanguageModelV2 that replays a scripted list of responses.
 *
 * Mastra's resolveModelConfig (llm/model/resolve-model.ts) wraps any object
 * carrying specificationVersion "v2" in its AISDKV5LanguageModel adapter and
 * treats it as a fully-resolved model — no provider string, no gateway
 * lookup. That is the seam: it sits under the Agent rather than replacing
 * it, so the real Agent drives its tools, its structured-output schema and
 * its processors against this instead of against our own mock.
 *
 * Shape verified against the installed @mastra/core@1.37.1: doGenerate's
 * `content` entries and doStream's protocol events (text-start/-delta/-end,
 * a bare tool-call, then finish) mirror @mastra/core's own
 * src/test-utils/llm-mock.ts createMockModel, not the brief's first guess —
 * doStream in particular is a delta-based event stream, not the array of
 * whole content parts doGenerate returns.
 */
export function stubModel(responses: StubResponse[]): MastraModelConfig {
  let call = 0;
  const next = (): StubResponse => responses[Math.min(call++, responses.length - 1)] ?? {};
  const finishReasonFor = (response: StubResponse): "tool-calls" | "stop" =>
    response.toolCalls?.length ? "tool-calls" : "stop";

  return {
    specificationVersion: "v2" as const,
    provider: "stub",
    modelId: "stub-model",
    supportedUrls: {},
    async doGenerate() {
      const response = next();
      return {
        content: toContent(response),
        finishReason: finishReasonFor(response),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    },
    async doStream() {
      const response = next();
      const content = toContent(response);
      const finishReason = finishReasonFor(response);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const part of content) {
              if (part.type === "text") {
                controller.enqueue({ type: "text-start", id: "stub-text" });
                controller.enqueue({ type: "text-delta", id: "stub-text", delta: part.text });
                controller.enqueue({ type: "text-end", id: "stub-text" });
              } else {
                controller.enqueue(part);
              }
            }
            controller.enqueue({
              type: "finish",
              finishReason,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            });
            controller.close();
          },
        }),
        warnings: [],
      };
    },
  };
}

/**
 * A model whose doGenerate/doStream never settle.
 *
 * Dumb on purpose, and deliberately separate from stubModel: it exists only
 * so coordinator.test.ts can force runInvestigation's real 50ms deadline
 * (investigator.ts's withDeadline) to fire deterministically, without a real
 * network call ever being in flight to race against. No timers are started —
 * an unresolved Promise costs nothing and keeps nothing alive — so the wall
 * clock is exactly investigator.ts's own AbortController-backed timeout.
 */
export function hangingModel(): MastraModelConfig {
  // never (the bottom type) is assignable to any doGenerate/doStream result,
  // so this satisfies both call signatures without describing a fake result
  // shape that would never actually be produced.
  const neverSettles = (): Promise<never> => new Promise<never>(() => {});
  return {
    specificationVersion: "v2" as const,
    provider: "stub",
    modelId: "stub-hanging-model",
    supportedUrls: {},
    doGenerate: neverSettles,
    doStream: neverSettles,
  };
}

/** A model whose every call rejects immediately with `message`. */
export function throwingModel(message: string): MastraModelConfig {
  const reject = (): Promise<never> => Promise.reject(new Error(message));
  return {
    specificationVersion: "v2" as const,
    provider: "stub",
    modelId: "stub-throwing-model",
    supportedUrls: {},
    doGenerate: reject,
    doStream: reject,
  };
}
