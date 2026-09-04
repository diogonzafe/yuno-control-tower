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
    // Re-confirms on every window the drop is still confirmed, not only on the
    // one that first crossed the bar. `emitted` gating promotion made one
    // continuous fault emit exactly one signal and then go quiet — and every
    // stage downstream runs on signals, including the `openOrUpdate` that bumps
    // `detected_at`, which is what orchestrate/lifecycle.ts reads as "still
    // live". A fault that never stopped was therefore resolved
    // RESOLVE_AFTER_QUIET_WINDOWS after its only promotion and reopened as a
    // fresh incident whenever the streak rebuilt.
    //
    // Suppressing the repeat was never what stops re-alerting: `openOrUpdate`
    // already answers a re-confirmation with `monitoring`, updating the
    // incident without alerting again (roadmap.md §5). `emitted` now only marks
    // a streak as confirmed, which is what tells a "watching" card from an
    // incident (the `pending` list in tick.ts).
    if (entry.count >= persistenceWindows) { entry.emitted = true; promoted.push(c); }
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
