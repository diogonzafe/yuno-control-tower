import assert from "node:assert/strict";
import test from "node:test";

import { transactionsPerSecond } from "./volume.ts";

test("volume remains bounded around the configured base TPS", () => {
  const lowTraffic = transactionsPerSecond(new Date("2026-08-30T04:00:00.000Z"), 60);
  const peakTraffic = transactionsPerSecond(new Date("2026-08-30T18:00:00.000Z"), 60);
  const dailyAverage = Array.from({ length: 24 }, (_, hour) =>
    transactionsPerSecond(new Date(Date.UTC(2026, 7, 30, hour)), 60),
  ).reduce((sum, tps) => sum + tps, 0) / 24;

  assert.ok(lowTraffic > 0);
  assert.ok(peakTraffic > lowTraffic);
  assert.ok(Math.abs(dailyAverage - 60) < 1e-12);
});
