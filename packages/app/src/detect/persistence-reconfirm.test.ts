import { describe, it, expect } from "vitest";
import { fingerprint, step } from "./persistence.js";
import type { Candidate } from "./trigger.js";

const dims = { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" };
const candidate: Candidate = { dimensions: dims, state: "MATERIAL_DROP", ci: { low: .1, high: .3 }, observedRate: .2, expectedRate: .9, expectedSource: "cross_sectional", deltaPp: 3, attempts: 100, approved: 20, windowUsed: "1m" };
const recovered: Candidate = { ...candidate, state: "HEALTHY", ci: { low: .88, high: .96 }, observedRate: .93, approved: 93 };

function confirmed(): ReturnType<typeof step> {
  let state = new Map();
  state = step([candidate], state, "t1").next;
  state = step([candidate], state, "t2").next;
  return step([candidate], state, "t3");
}

/**
 * A drop that is still happening has to keep saying so.
 *
 * `emitted` used to gate promotion itself, so one continuous fault produced
 * exactly one signal and then silence. Everything downstream runs on signals —
 * runDiagnosis, buildEvidence, and the `openOrUpdate` that bumps `detected_at`
 * — while `orchestrate/lifecycle.ts` resolves any active incident whose
 * `detected_at` is RESOLVE_AFTER_QUIET_WINDOWS old. A continuous fault was
 * therefore guaranteed to be resolved three windows after its only promotion
 * and reopened as a new incident whenever the streak happened to rebuild.
 *
 * Measured on 2026-09-04: a cell flat at ~13% for 44 minutes emitted evidence
 * in 5 of them, and produced seven incidents.
 *
 * Re-alerting is not what this flag protects against — `openOrUpdate` already
 * returns `monitoring` for a re-confirmation and updates without alerting
 * (roadmap.md §5). `emitted` now only marks a streak as confirmed, which is
 * what separates a "watching" card from an incident.
 */
describe("a standing streak keeps re-confirming", () => {
  it("promotes again on every window the drop is still confirmed", () => {
    const third = confirmed();
    expect(third.promoted).toEqual([candidate]);

    const fourth = step([candidate], third.next, "t4");
    expect(fourth.promoted).toEqual([candidate]);

    const fifth = step([candidate], fourth.next, "t5");
    expect(fifth.promoted).toEqual([candidate]);
    // The count keeps climbing, so the evidence can say how long this has run.
    expect(fifth.next.get(fingerprint(dims))?.count).toBe(5);
  });

  it("still marks the streak as confirmed, so it is no longer a watching card", () => {
    expect(confirmed().next.get(fingerprint(dims))?.emitted).toBe(true);
  });

  it("stops the moment a confident reading says the cell is not down", () => {
    const third = confirmed();
    const fourth = step([recovered], third.next, "t4");

    expect(fourth.promoted).toEqual([]);
    // The streak is gone, not paused: recovery is the one thing that clears it.
    expect(fourth.next.has(fingerprint(dims))).toBe(false);
  });

  // The gap tolerance stays as persistence-gap.test.ts fixed it: a window with
  // no confident reading is not evidence the drop stopped, so it neither
  // promotes nor resets.
  it("does not re-confirm on a window it could not read", () => {
    const third = confirmed();
    const fourth = step([], third.next, "t4");

    expect(fourth.promoted).toEqual([]);
    expect(fourth.next.get(fingerprint(dims))?.count).toBe(3);
    expect(step([candidate], fourth.next, "t5").promoted).toEqual([candidate]);
  });
});
