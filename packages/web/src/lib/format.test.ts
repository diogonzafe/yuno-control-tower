import test from "node:test";
import assert from "node:assert/strict";

import { formatUsdPerMinute } from "./format.ts";

test("formats a positive USD exposure per minute", () => {
  assert.equal(formatUsdPerMinute(412), "$412/min");
});

test("formats a zero USD exposure per minute", () => {
  assert.equal(formatUsdPerMinute(0), "$0/min");
});
