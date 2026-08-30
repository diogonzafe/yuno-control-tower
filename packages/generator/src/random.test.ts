import { describe, expect, it } from "vitest";

import { createSeededRandom } from "./random.ts";

describe("createSeededRandom", () => {
  it("produces a repeatable sequence", () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);

    expect([first.next(), first.next(), first.next()]).toEqual([
      second.next(),
      second.next(),
      second.next(),
    ]);
  });

  it("rejects a weighted selection with an invalid distribution", () => {
    const random = createSeededRandom(1);

    expect(() => random.weightedPick([{ value: "invalid", weight: 0 }])).toThrow(/positive total weight/);
  });

  it("int() rejects a non-positive bound", () => {
    const random = createSeededRandom(1);

    expect(() => random.int(0)).toThrow(/positive integer/);
  });
});
