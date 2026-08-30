import { describe, expect, it } from "vitest";
import { aggregate, aggregateByBucket } from "./aggregate.js";
import { crossSectionalExpected, temporalExpected } from "./expected.js";
import { onsetScan } from "./onset-scan.js";
import { fingerprint, step } from "./persistence.js";
import { absoluteTrigger, crossSectionalSweep, type Candidate } from "./trigger.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "./types.js";
import { evaluate, wilson } from "./wilson.js";

const bucket = "2026-08-30T14:00:00.000Z";
const row = (overrides: Partial<RollupRow> = {}): RollupRow => ({ bucket, merchantId: "BR_STORE_01", providerId: "adyen", country: "BR", paymentMethod: "CARD", issuerId: "itau", attempts: 100, approved: 95, amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950, ...overrides });
const merchant: MerchantConfig = { merchantId: "BR_STORE_01", expectedConversion: .9, minMaterialDropPp: 3 };
const coverage: RoutingCoverage = ["adyen", "stripe", "mercado_pago"].flatMap((providerId) => [{ providerId, country: "BR", paymentMethod: "CARD" }, { providerId, country: "BR", paymentMethod: "PIX" }]);

describe("Wilson decision", () => {
  it("computes the closed interval and all decision states", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilson(2, 5).low).toBeCloseTo(.1176, 3);
    expect(evaluate(9, 30, .7, 3, 30).state).toBe("MATERIAL_DROP");
    expect(evaluate(28, 30, .7, 3, 30).state).toBe("HEALTHY");
    expect(evaluate(4, 6, .7, 3, 30).state).toBe("INSUFFICIENT_EVIDENCE");
    expect(evaluate(20, 30, .7, 3, 30).state).toBe("MONITORING");
  });
});

describe("aggregation and expected rate", () => {
  const rows = [row({ providerId: "adyen", attempts: 100, approved: 30 }), row({ providerId: "stripe", attempts: 100, approved: 90 }), row({ providerId: "mercado_pago", attempts: 100, approved: 95 })];
  it("uses one filtered aggregation, including parent-minus-child", () => {
    expect(aggregate(rows).rate).toBeCloseTo(215 / 300);
    expect(aggregate(rows, { exclude: { providerId: "adyen" } }).rate).toBeCloseTo(.925);
    expect(crossSectionalExpected(rows, { merchantId: "BR_STORE_01", country: "BR" }, "providerId", "adyen")).toBeCloseTo(.925);
    expect(temporalExpected([...rows, row({ bucket: "2026-08-30T15:00:00.000Z", approved: 0 })], { merchantId: "BR_STORE_01" }, bucket, "2026-08-30T15:00:00.000Z")).toBeCloseTo(215 / 300);
    expect(aggregateByBucket([...rows, row({ bucket: "2026-08-30T13:00:00.000Z" })]).map((x) => x.bucket)).toEqual(["2026-08-30T13:00:00.000Z", bucket]);
  });
});

describe("triggers", () => {
  it("uses merchant aggregate only for expected_conversion and valid covered siblings for sweep", () => {
    expect(absoluteTrigger([row({ attempts: 300, approved: 90 })], [merchant])[0]).toMatchObject({ dimensions: { merchantId: "BR_STORE_01", country: "BR" }, state: "MATERIAL_DROP" });
    const rows = [row({ providerId: "adyen", issuerId: "itau", attempts: 100, approved: 20 }), row({ providerId: "stripe", attempts: 100, approved: 95 }), row({ providerId: "mercado_pago", attempts: 100, approved: 95 })];
    expect(crossSectionalSweep(rows, coverage, [merchant]).some((c) => c.dimensions.providerId === "adyen" && c.state === "MATERIAL_DROP")).toBe(true);
    expect(crossSectionalSweep([...rows, row({ providerId: "uncov", attempts: 100, approved: 0 })], coverage, [merchant]).some((c) => c.dimensions.providerId === "uncov")).toBe(false);
  });
});

describe("persistence and onset", () => {
  const dims = { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" };
  const candidate: Candidate = { dimensions: dims, state: "MATERIAL_DROP", ci: { low: .1, high: .3 }, observedRate: .2, expectedRate: .9, expectedSource: "cross_sectional", deltaPp: 3, attempts: 100, approved: 20, windowUsed: "1m" };
  it("promotes once on the third consecutive tick and finds the onset", () => {
    let state = new Map(); state = step([candidate], state, "t1").next; state = step([candidate], state, "t2").next; const third = step([candidate], state, "t3");
    expect(third.promoted).toEqual([candidate]); expect(third.next.get(fingerprint(dims))?.emitted).toBe(true); expect(step([candidate], third.next, "t4").promoted).toEqual([]);
    const series = [95, 20, 20, 20].map((approved, i) => row({ bucket: new Date(Date.UTC(2026, 7, 30, 14, i)).toISOString(), providerId: "adyen", approved }));
    expect(onsetScan(series, { merchantId: "BR_STORE_01", providerId: "adyen" }, series[3]!.bucket, .9, 3)).toEqual({ startedAt: series[1]!.bucket, startedAtExact: true });
  });
});
