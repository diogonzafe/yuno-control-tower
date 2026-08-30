import type { EvidenceObject } from "@control-tower/contracts";

export type EvidenceStore = {
  add(evidence: EvidenceObject[]): void;
  recent(limit?: number): EvidenceObject[];
};

const DEFAULT_CAP = 200;

// Same shape and the same reason as signal-store.ts: evidence lives only in
// this process. Persisting it to `incidents` and deduping by fingerprint is
// orchestrate/'s job, and that module does not exist yet.
export function createEvidenceStore(cap = DEFAULT_CAP): EvidenceStore {
  const evidence: EvidenceObject[] = [];

  return {
    add(incoming) {
      for (const item of incoming) evidence.unshift(item);
      evidence.length = Math.min(evidence.length, cap);
    },
    recent(limit = cap) {
      return evidence.slice(0, limit);
    },
  };
}
