import test from "node:test";
import assert from "node:assert/strict";

import { formatLocal, formatPercent, formatSignedPp, formatUsd, formatUsdPerMin } from "./format.ts";

test("formats a rate as a percentage", () => {
  assert.equal(formatPercent(0.764), "76.4%");
});

test("formats a positive and negative delta in percentage points", () => {
  assert.equal(formatSignedPp(3.2), "+3.2pp");
  assert.equal(formatSignedPp(-11.2), "−11.2pp");
});

test("formats USD minor units, compacting past one thousand", () => {
  assert.equal(formatUsd(41200), "US$ 412");
  assert.equal(formatUsd(1_420_000_00), "US$ 1420.0k");
});

test("formats a USD-per-minute cost", () => {
  assert.equal(formatUsdPerMin(41200), "US$ 412/min");
});

test("formats a local-currency amount with its currency code", () => {
  assert.equal(formatLocal(12840000, "BRL"), "BRL 128.4k");
});
