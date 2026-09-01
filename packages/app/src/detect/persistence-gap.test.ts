import { describe, it, expect } from "vitest";
import { fingerprint, step } from "./persistence.js";
import type { Candidate } from "./trigger.js";

const dims = { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" };
const candidate: Candidate = { dimensions: dims, state: "MATERIAL_DROP", ci: { low: .1, high: .3 }, observedRate: .2, expectedRate: .9, expectedSource: "cross_sectional", deltaPp: 3, attempts: 100, approved: 20, windowUsed: "1m" };

describe("persistence survives a volume gap", () => {
  it("does not reset the streak when a tick has no reading for the fingerprint (low-volume/no-data minute)", () => {
    let state = new Map();
    state = step([candidate], state, "t1").next; // count=1
    state = step([candidate], state, "t2").next; // count=2
    state = step([], state, "t3").next;           // gap: no candidate this tick (low volume)
    const fourth = step([candidate], state, "t4"); // should promote: this is the 3rd real material window
    expect(fourth.promoted).toEqual([candidate]);
  });
});
