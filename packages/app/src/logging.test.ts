import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logging.js";

function capture(): { lines: unknown[]; stream: Writable } {
  const lines: unknown[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  return { lines, stream };
}

describe("createLogger", () => {
  it("serializes an Error logged under the `error` key", () => {
    const { lines, stream } = capture();
    const logger = createLogger("test", stream).child({}, { level: "info" });

    logger.error({ error: new Error("boom") }, "agent coordinator failed");

    // The whole bug: without the serializer this was `"error":{}` in production.
    const [line] = lines as { error: { type: string; message: string; stack: string } }[];
    expect(line!.error.type).toBe("Error");
    expect(line!.error.message).toBe("boom");
    expect(line!.error.stack).toContain("logging.test.ts");
  });

  it("passes a non-Error through untouched", () => {
    const { lines, stream } = capture();
    const logger = createLogger("test", stream).child({}, { level: "info" });

    // Every call site types the caught value as `unknown`, so a rejected
    // promise carrying a string must not be mangled either.
    logger.error({ error: "just a string" }, "detection tick failed");

    const [line] = lines as { error: string }[];
    expect(line!.error).toBe("just a string");
  });
});
