import { describe, expect, it } from "vitest";

import { transactionsPerSecond } from "./volume.ts";

describe("transactionsPerSecond", () => {
  it("remains bounded around the configured base TPS", () => {
    const lowTraffic = transactionsPerSecond(new Date("2026-08-30T04:00:00.000Z"), 60);
    const peakTraffic = transactionsPerSecond(new Date("2026-08-30T18:00:00.000Z"), 60);
    const dailyAverage = Array.from({ length: 24 }, (_, hour) =>
      transactionsPerSecond(new Date(Date.UTC(2026, 7, 30, hour)), 60),
    ).reduce((sum, tps) => sum + tps, 0) / 24;

    expect(lowTraffic).toBeGreaterThan(0);
    expect(peakTraffic).toBeGreaterThan(lowTraffic);
    expect(Math.abs(dailyAverage - 60)).toBeLessThan(1e-12);
  });

  it("rejects a non-positive baseTps", () => {
    expect(() => transactionsPerSecond(new Date(), 0)).toThrow(/baseTps must be positive/);
  });
});
