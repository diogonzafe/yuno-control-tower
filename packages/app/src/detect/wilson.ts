import type { CellState } from "@control-tower/contracts";
import { Z } from "./constants.js";

export type Interval = { low: number; high: number };
export function wilson(k: number, n: number, z = Z): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n, d = 1 + z ** 2 / n;
  const center = (p + z ** 2 / (2 * n)) / d;
  const half = z / d * Math.sqrt(p * (1 - p) / n + z ** 2 / (4 * n ** 2));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}
export function evaluate(k: number, n: number, expected: number, deltaPp: number, minVolume: number): { state: CellState; ci: Interval } {
  const ci = wilson(k, n), limit = expected - deltaPp / 100;
  if (ci.high < limit) return { state: "MATERIAL_DROP", ci };
  if (ci.low > limit) return { state: "HEALTHY", ci };
  return { state: n < minVolume ? "INSUFFICIENT_EVIDENCE" : "MONITORING", ci };
}
