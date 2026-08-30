export type WeightedValue<T> = {
  value: T;
  weight: number;
};

export type SeededRandom = {
  next: () => number;
  int: (exclusiveUpperBound: number) => number;
  weightedPick: <T>(values: readonly WeightedValue<T>[]) => T;
};

export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;

  const next = (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };

  return {
    next,
    int(exclusiveUpperBound) {
      if (!Number.isInteger(exclusiveUpperBound) || exclusiveUpperBound <= 0) {
        throw new Error("exclusiveUpperBound must be a positive integer");
      }

      return Math.floor(next() * exclusiveUpperBound);
    },
    weightedPick<T>(values: readonly WeightedValue<T>[]): T {
      const totalWeight = values.reduce((total, entry) => total + entry.weight, 0);
      if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
        throw new Error("weighted selection requires a positive total weight");
      }

      const target = next() * totalWeight;
      let cumulativeWeight = 0;
      for (const entry of values) {
        if (!Number.isFinite(entry.weight) || entry.weight < 0) {
          throw new Error("weights must be finite non-negative numbers");
        }
        cumulativeWeight += entry.weight;
        if (target < cumulativeWeight) return entry.value;
      }

      return values.at(-1)!.value;
    },
  };
}
