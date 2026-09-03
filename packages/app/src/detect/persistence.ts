import { PERSISTENCE_WINDOWS } from "./constants.js";
import type { Candidate } from "./trigger.js";
import type { SliceFilter } from "./types.js";
// `candidate` is the latest confident MATERIAL_DROP reading for this
// fingerprint — carried so a still-accumulating (not yet emitted) streak has
// something displayable (dashboard "watching" cards) without re-deriving it.
export type PersistenceEntry = { count: number; firstBucket: string; emitted: boolean; candidate: Candidate };
export type PersistenceState = Map<string, PersistenceEntry>;
const KEYS: Array<keyof SliceFilter> = ["merchantId", "providerId", "country", "paymentMethod", "issuerId"];
export function fingerprint(dims: SliceFilter): string { return KEYS.filter((k) => dims[k] !== undefined).sort().map((k) => `${k}=${dims[k]}`).join("|"); }
export function step(candidates: Candidate[], prev: PersistenceState, bucket: string, persistenceWindows = PERSISTENCE_WINDOWS): { promoted: Candidate[]; next: PersistenceState } {
  const next: PersistenceState = new Map(), promoted: Candidate[] = [], seen = new Set<string>();
  for (const c of candidates) {
    const fp = fingerprint(c.dimensions);
    seen.add(fp);
    if (c.state !== "MATERIAL_DROP") continue;
    const before = prev.get(fp); const entry = before ? { ...before, count: before.count + 1, candidate: c } : { count: 1, firstBucket: bucket, emitted: false, candidate: c };
    if (entry.count >= persistenceWindows && !entry.emitted) { entry.emitted = true; promoted.push(c); }
    next.set(fp, entry);
  }
  // A fingerprint absent from `candidates` this tick had no confident reading —
  // low volume (INSUFFICIENT_EVIDENCE) or no matching rows at all — not a
  // confirmed non-drop. That is not evidence the drop stopped, so its streak
  // carries forward unchanged instead of being discarded; only a candidate
  // this tick with a real non-MATERIAL_DROP verdict resets it (the `continue`
  // above, which leaves that fingerprint out of `next`).
  for (const [fp, entry] of prev) { if (!seen.has(fp)) next.set(fp, entry); }
  return { promoted, next };
}
