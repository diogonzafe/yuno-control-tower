import { describe, expect, test } from "vitest";
import { aggregate } from "./aggregate.js";
import { rollupRow } from "./fixtures.js";

describe("aggregate", () => {
  // Local-currency cost (incidents.cost_local) needs the local-amount column
  // that rollup_minute already stores as amount_minor_sum.
  test("sums the local amount alongside the USD amounts", () => {
    const rows = [
      rollupRow({ amountMinorSum: 500_000 }),
      rollupRow({ providerId: "stripe", amountMinorSum: 250_000 }),
    ];

    expect(aggregate(rows).amountMinorSum).toBe(750_000);
  });
});
