const HOUR_MULTIPLIER = [
  0.28, 0.24, 0.2, 0.18, 0.2, 0.28, 0.42, 0.58,
  0.72, 0.84, 0.92, 0.98, 1.04, 1.1, 1.16, 1.22,
  1.28, 1.34, 1.36, 1.28, 1.12, 0.9, 0.66, 0.44,
] as const;
const AVERAGE_HOUR_MULTIPLIER = HOUR_MULTIPLIER.reduce((sum, value) => sum + value, 0) / HOUR_MULTIPLIER.length;

/** DD7: traffic is seasonal; approval probability is not. */
export function transactionsPerSecond(at: Date, baseTps = 60): number {
  if (!Number.isFinite(baseTps) || baseTps <= 0) {
    throw new Error("baseTps must be positive");
  }

  return baseTps * HOUR_MULTIPLIER[at.getUTCHours()]! / AVERAGE_HOUR_MULTIPLIER;
}
