import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";

export type SignalStore = {
  addSignals(signals: ConfirmedDrop[]): void;
  addGaps(gaps: EvidenceGap[]): void;
  recentSignals(limit?: number): ConfirmedDrop[];
  recentGaps(limit?: number): EvidenceGap[];
};

const DEFAULT_CAP = 200;

// Signals live only in this process: writing them to `incidents` is
// orchestrate/'s job, and that module does not exist yet.
export function createSignalStore(cap = DEFAULT_CAP): SignalStore {
  const signals: ConfirmedDrop[] = [];
  const gaps: EvidenceGap[] = [];

  function push<T>(buffer: T[], items: T[]): void {
    for (const item of items) {
      buffer.unshift(item);
    }
    buffer.length = Math.min(buffer.length, cap);
  }

  return {
    addSignals(incoming) {
      push(signals, incoming);
    },
    addGaps(incoming) {
      push(gaps, incoming);
    },
    recentSignals(limit = cap) {
      return signals.slice(0, limit);
    },
    recentGaps(limit = cap) {
      return gaps.slice(0, limit);
    },
  };
}
