import { describe, expect, test } from "vitest";
import { estimateImpact } from "./cost.js";
import { BR_CAUSAL, BUCKET, brFullGrid, minutesBefore } from "./fixtures.js";

const threeMinutes = [2, 1, 0].map((back) => minutesBefore(BUCKET, back));

describe("estimateImpact", () => {
  test("prices one window of the causal cell in USD and local currency", () => {
    const impact = estimateImpact(brFullGrid(), BR_CAUSAL, 0.95, BUCKET, BUCKET);

    expect(impact.durationMin).toBe(1);
    expect(impact.lostApprovals).toBe(243);
    expect(impact.avgTicketUsdMinor).toBe(10_000);
    expect(impact.costUsdMinor).toBe(2_430_000);
    expect(impact.costLocal).toEqual({ BRL: 12_150_000 });
    expect(impact.costUsdPerMin).toBeCloseTo(2_430_000, 2);
  });

  test("counts lost approvals from the optimistic edge, never from the observed rate", () => {
    // The cell converts at 10% against 95% expected. Charging the observed gap
    // would bill 255 lost approvals; the Wilson upper bound makes the number a
    // floor instead of a guess (DD11).
    const impact = estimateImpact(brFullGrid(), BR_CAUSAL, 0.95, BUCKET, BUCKET);

    expect(impact.lostApprovals).toBeLessThan(300 * (0.95 - 0.1));
  });

  test("accumulates over the incident and reports the per-minute reading", () => {
    const rows = threeMinutes.flatMap((bucket) => brFullGrid(bucket));

    const impact = estimateImpact(rows, BR_CAUSAL, 0.95, threeMinutes[0]!, BUCKET);

    expect(impact.durationMin).toBe(3);
    expect(impact.lostApprovals).toBe(746);
    expect(impact.costUsdMinor).toBe(7_460_000);
    expect(impact.costUsdPerMin).toBeCloseTo(7_460_000 / 3, 2);
  });

  test("scores priority as the conservative cost per minute", () => {
    const impact = estimateImpact(brFullGrid(), BR_CAUSAL, 0.95, BUCKET, BUCKET);

    expect(impact.priorityScore).toBe(impact.costUsdPerMin);
  });
});
