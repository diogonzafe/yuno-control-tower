import type { EvidenceObject } from "@control-tower/contracts";

export type EvidenceStore = {
  add(evidence: EvidenceObject[]): void;
  recent(limit?: number): EvidenceObject[];
};

const DEFAULT_CAP = 200;

function sameIncident(a: EvidenceObject, b: EvidenceObject): boolean {
  return a.fingerprint === b.fingerprint && a.windowBucket === b.windowBucket;
}

// Same shape and the same reason as signal-store.ts: evidence lives only in
// this process. Persisting it to `incidents` and deduping by fingerprint is
// orchestrate/'s job, and that module does not exist yet.
export function createEvidenceStore(cap = DEFAULT_CAP): EvidenceStore {
  const evidence: EvidenceObject[] = [];

  return {
    add(incoming) {
      for (const item of incoming) {
        // The same incident arrives twice by design: the scheduler emits the
        // deterministic evidence the moment a drop confirms, and the agent
        // emits a richer version for the same cell once its run finishes.
        // Replacing in place keeps the deterministic path running every tick
        // (so cutting agent/ stays a one-line change, per roadmap §7) without
        // showing the operator the same incident twice.
        const existing = evidence.findIndex((candidate) => sameIncident(candidate, item));
        if (existing >= 0) {
          evidence.splice(existing, 1);
        }
        evidence.unshift(item);
      }
      evidence.length = Math.min(evidence.length, cap);
    },
    recent(limit = cap) {
      return evidence.slice(0, limit);
    },
  };
}
