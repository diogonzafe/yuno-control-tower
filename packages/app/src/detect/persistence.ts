import { PERSISTENCE_WINDOWS } from "./constants.js";
import type { Candidate } from "./trigger.js";
import type { SliceFilter } from "./types.js";
export type PersistenceEntry = { count: number; firstBucket: string; emitted: boolean };
export type PersistenceState = Map<string, PersistenceEntry>;
const KEYS: Array<keyof SliceFilter> = ["merchantId", "providerId", "country", "paymentMethod", "issuerId"];
export function fingerprint(dims: SliceFilter): string { return KEYS.filter((k) => dims[k] !== undefined).sort().map((k) => `${k}=${dims[k]}`).join("|"); }
export function step(candidates: Candidate[], prev: PersistenceState, bucket: string): { promoted: Candidate[]; next: PersistenceState } {
  const next: PersistenceState = new Map(), promoted: Candidate[] = [];
  for (const c of candidates) { if (c.state !== "MATERIAL_DROP") continue; const before = prev.get(fingerprint(c.dimensions)); const entry = before ? { ...before, count: before.count + 1 } : { count: 1, firstBucket: bucket, emitted: false }; if (entry.count >= PERSISTENCE_WINDOWS && !entry.emitted) { entry.emitted = true; promoted.push(c); } next.set(fingerprint(c.dimensions), entry); }
  return { promoted, next };
}
