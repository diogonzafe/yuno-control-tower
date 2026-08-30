import assert from "node:assert/strict";
import test from "node:test";

import { createSeededRandom } from "./random.ts";

test("seeded random produces a repeatable sequence", () => {
  const first = createSeededRandom(42);
  const second = createSeededRandom(42);

  assert.deepEqual(
    [first.next(), first.next(), first.next()],
    [second.next(), second.next(), second.next()],
  );
});

test("weighted selection rejects an invalid distribution", () => {
  const random = createSeededRandom(1);

  assert.throws(
    () => random.weightedPick([{ value: "invalid", weight: 0 }]),
    /positive total weight/,
  );
});
