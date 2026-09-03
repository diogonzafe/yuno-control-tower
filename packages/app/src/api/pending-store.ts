import type { PendingSignal } from "@control-tower/contracts";

export type PendingStore = {
  replace(pending: PendingSignal[]): void;
  current(): PendingSignal[];
};

// Unlike signal-store.ts's append-only log, this is a full replace each tick:
// "pending" means "true right now", not a history. The scheduler always
// passes every fingerprint still on a live streak — one this hasn't seen
// before, or the same one continuing — so a straight replace never drops a
// fingerprint that is genuinely still pending.
export function createPendingStore(): PendingStore {
  let pending: PendingSignal[] = [];

  return {
    replace(incoming) {
      pending = incoming;
    },
    current() {
      return pending;
    },
  };
}
