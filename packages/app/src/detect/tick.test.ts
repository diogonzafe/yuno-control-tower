import { describe, expect, it } from "vitest";
import { runDetectionTick } from "./tick.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "./types.js";

const merchant: MerchantConfig = { merchantId: "BR_STORE_01", expectedConversion: .9, minMaterialDropPp: 3 };
const coverage: RoutingCoverage = ["adyen", "stripe", "mercado_pago"].map((providerId) => ({ providerId, country: "BR", paymentMethod: "CARD" }));
function window(bucket: string, adyenApproved = 20): RollupRow[] {
  return ["adyen", "stripe", "mercado_pago"].map((providerId) => ({ bucket, merchantId: "BR_STORE_01", providerId, country: "BR" as const, paymentMethod: "CARD" as const, issuerId: "itau", attempts: 100, approved: providerId === "adyen" ? adyenApproved : 95, amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950 }));
}
// The jury's two-simultaneous-incidents scenario: one severe cause and one
// moderate cause in disjoint cells under the same merchant.
function dualCauseGrid(bucket: string, severeApproved: number, moderateApproved: number): RollupRow[] {
  const cell = (providerId: string, issuerId: string, approved: number): RollupRow => ({
    bucket, merchantId: "BR_STORE_01", providerId, country: "BR" as const, paymentMethod: "CARD" as const,
    issuerId, attempts: 100, approved, amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950,
  });
  return ["stripe", "adyen", "mercado_pago"].flatMap((providerId) =>
    ["itau", "nubank", "bradesco"].map((issuerId) => {
      if (providerId === "stripe" && issuerId === "itau") return cell(providerId, issuerId, severeApproved);
      if (providerId === "adyen" && issuerId === "nubank") return cell(providerId, issuerId, moderateApproved);
      return cell(providerId, issuerId, 90);
    }),
  );
}

describe("runDetectionTick", () => {
  // Cross-sectional expectation comes from a cell's siblings, so two causes
  // under one root each drag the other's baseline down until neither looks
  // material: in production the severe cause pulled adyen's reference from
  // ~0.886 to ~0.780, leaving the moderate cause 2.7pp below it — under the
  // 3pp threshold. Comparing a cell against its own past is immune to that.
  it("finds the moderate cause that a severe sibling masks", () => {
    const history = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
      new Date(Date.UTC(2026, 7, 30, 19, i)).toISOString(),
    ).flatMap((b) => dualCauseGrid(b, 90, 90)); // tudo saudável no passado
    const buckets = [10, 11].map((i) => new Date(Date.UTC(2026, 7, 30, 19, i)).toISOString());

    let state = new Map();
    let last;
    for (const bucket of buckets) {
      last = runDetectionTick({
        bucket,
        windowRows: dualCauseGrid(bucket, 13, 45), // severa 0.13, moderada 0.45
        history,
        merchants: [merchant],
        coverage,
        prevState: state,
        persistenceWindows: 2,
      });
      state = last.nextState;
    }

    const cells = last!.signals.map((s) => `${s.dimensions.providerId ?? ""}/${s.dimensions.issuerId ?? ""}`);
    expect(cells.some((c) => c.includes("stripe") || c.includes("itau"))).toBe(true);
    expect(cells.some((c) => c.includes("adyen") || c.includes("nubank"))).toBe(true);
  });

  it("confirms a cross-sectional provider drop once after three consecutive windows", () => {
    const buckets = [0, 1, 2].map((i) => new Date(Date.UTC(2026, 7, 30, 14, i)).toISOString());
    let state = new Map(); let last;
    for (let i = 0; i < 3; i++) {
      last = runDetectionTick({ bucket: buckets[i]!, windowRows: window(buckets[i]!), history: buckets.slice(0, i).flatMap((b) => window(b)), merchants: [merchant], coverage, prevState: state });
      state = last.nextState;
      if (i < 2) expect(last.signals).toEqual([]);
    }
    const hit = last!.signals.find((signal) => signal.dimensions.providerId === "adyen");
    expect(hit).toMatchObject({ expectedSource: "cross_sectional", consecutiveWindows: 3, startedAt: buckets[0], startedAtExact: true });
  });

  it("retries a thin drop over five minutes before confirming it", () => {
    const buckets = [0, 1, 2, 3, 4, 5].map((i) => new Date(Date.UTC(2026, 7, 30, 15, i)).toISOString());
    let state = new Map();
    let last: ReturnType<typeof runDetectionTick> | undefined;
    for (let i = 0; i < buckets.length; i++) {
      last = runDetectionTick({
        bucket: buckets[i]!,
        windowRows: window(buckets[i]!).map((entry) => entry.providerId === "adyen" ? { ...entry, attempts: 8, approved: 1 } : entry),
        history: buckets.slice(0, i).flatMap((previous) => window(previous).map((entry) => entry.providerId === "adyen" ? { ...entry, attempts: 8, approved: 1 } : entry)),
        merchants: [merchant], coverage, prevState: state,
      });
      state = last.nextState;
    }
    const hit = last!.signals.find((signal) => signal.dimensions.providerId === "adyen");
    expect(hit).toMatchObject({ windowUsed: "5m", attempts: 40, consecutiveWindows: 3 });
  });

  it("emits an EvidenceGap, never a signal, when five minutes remain thin", () => {
    const buckets = [0, 1, 2, 3, 4].map((i) => new Date(Date.UTC(2026, 7, 30, 16, i)).toISOString());
    const sparse = (at: string) => window(at).map((entry) => entry.providerId === "adyen" ? { ...entry, attempts: 1, approved: 0 } : entry);
    const result = runDetectionTick({ bucket: buckets[4]!, windowRows: sparse(buckets[4]!), history: buckets.slice(0, 4).flatMap(sparse), merchants: [merchant], coverage, prevState: new Map() });
    expect(result.signals).toEqual([]);
    expect(result.evidenceGaps).toContainEqual(expect.objectContaining({ dimensions: expect.objectContaining({ providerId: "adyen" }), attempts: 5, reason: "INSUFFICIENT_EVIDENCE" }));
  });

  // The retry path exists to give a THIN DROP a wider window before calling it.
  // A cell that already read as confidently healthy has nothing to re-measure,
  // and routing it there turned it into an INSUFFICIENT_EVIDENCE gap — which
  // orchestrate/lifecycle.ts reads as "we lost sight of this cell" and uses to
  // mark a recovering incident inconclusive instead of resolved.
  it("never reports a confidently healthy cell as an evidence gap", () => {
    const bucket = new Date(Date.UTC(2026, 7, 30, 18, 0)).toISOString();
    // adyen sits at 29/29 — below MIN_VOLUME, but its interval clears the
    // threshold outright because the siblings it is measured against are down.
    const rows: RollupRow[] = [
      { bucket, merchantId: "BR_STORE_01", providerId: "adyen", country: "BR", paymentMethod: "CARD", issuerId: "itau", attempts: 29, approved: 29, amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950 },
      ...["stripe", "mercado_pago"].map((providerId): RollupRow => ({ bucket, merchantId: "BR_STORE_01", providerId, country: "BR", paymentMethod: "CARD", issuerId: "itau", attempts: 400, approved: 340, amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950 })),
    ];

    const result = runDetectionTick({ bucket, windowRows: rows, history: [], merchants: [merchant], coverage, prevState: new Map() });

    expect(result.evidenceGaps.filter((g) => g.dimensions.providerId === "adyen")).toEqual([]);
  });

  it("clears a pending signal once the cell recovers, instead of leaving it stuck forever", () => {
    const buckets = [0, 1, 2].map((i) => new Date(Date.UTC(2026, 7, 30, 17, i)).toISOString());
    let state = new Map();

    const dropped = runDetectionTick({ bucket: buckets[0]!, windowRows: window(buckets[0]!), history: [], merchants: [merchant], coverage, prevState: state, persistenceWindows: 2 });
    state = dropped.nextState;
    expect(dropped.pending.some((p) => p.dimensions.providerId === "adyen")).toBe(true);

    // adyen recovers to match its siblings (approved=95) — no longer a drop.
    const recovered = runDetectionTick({ bucket: buckets[1]!, windowRows: window(buckets[1]!, 95), history: [buckets[0]!].flatMap((b) => window(b)), merchants: [merchant], coverage, prevState: state, persistenceWindows: 2 });
    state = recovered.nextState;

    expect(recovered.pending.some((p) => p.dimensions.providerId === "adyen")).toBe(false);

    // and it must not silently re-promote later just because the stale streak survived.
    const later = runDetectionTick({ bucket: buckets[2]!, windowRows: window(buckets[2]!, 95), history: buckets.slice(0, 2).flatMap((b, i) => window(b, i === 0 ? 20 : 95)), merchants: [merchant], coverage, prevState: state, persistenceWindows: 2 });
    expect(later.signals.some((s) => s.dimensions.providerId === "adyen")).toBe(false);
  });
});
