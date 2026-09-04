import { expect, test } from "vitest";

import { formatLocal, formatPercent, formatSignedPp, formatUsd, formatUsdPerMin } from "./format.ts";

test("formats a rate as a percentage", () => {
  expect(formatPercent(0.764)).toBe("76.4%");
});

test("formats a positive and negative delta in percentage points", () => {
  expect(formatSignedPp(3.2)).toBe("+3.2pp");
  expect(formatSignedPp(-11.2)).toBe("−11.2pp");
});

test("formats USD minor units, compacting past one thousand", () => {
  expect(formatUsd(41200)).toBe("US$ 412");
  expect(formatUsd(1_420_000_00)).toBe("US$ 1420.0k");
});

test("formats a USD-per-minute cost", () => {
  expect(formatUsdPerMin(41200)).toBe("US$ 412/min");
});

test("formats a local-currency amount with its currency code", () => {
  expect(formatLocal(12840000, "BRL")).toBe("BRL 128.4k");
});
