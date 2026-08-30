import { describe, expect, it } from "vitest";
import type { TransactionEvent } from "@control-tower/contracts";
import { aggregateDeltas } from "./rollup";

function baseEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    transactionId: "00000000-0000-4000-8000-000000000001",
    merchantOrderId: "order-1",
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 1000,
    fxRate: 5,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 200,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: null,
    latencyMs: null,
    createdAt: "2026-08-30T14:03:10.000Z",
    ...overrides,
  };
}

describe("aggregateDeltas", () => {
  it("returns empty deltas for an empty batch", () => {
    const result = aggregateDeltas([]);
    expect(result.minuteDeltas).toEqual([]);
    expect(result.declineDeltas).toEqual([]);
  });

  it("floors createdAt to the minute and sums attempts/approved/amounts for one cell", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", createdAt: "2026-08-30T14:03:05.000Z", amountMinor: 1000, amountUsdMinor: 200, status: "SUCCESS" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", createdAt: "2026-08-30T14:03:55.000Z", amountMinor: 2000, amountUsdMinor: 400, status: "DECLINED", declineCode: "05" }),
    ];

    const { minuteDeltas } = aggregateDeltas(events);

    expect(minuteDeltas).toHaveLength(1);
    expect(minuteDeltas[0]).toMatchObject({
      bucket: new Date("2026-08-30T14:03:00.000Z"),
      merchantId: "merchant-1",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
      attempts: 2,
      approved: 1,
      amountMinorSum: 3000,
      amountUsdSum: 600,
      approvedUsdSum: 200,
    });
  });

  it("splits events into separate cells across different minutes", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", createdAt: "2026-08-30T14:03:59.000Z" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", createdAt: "2026-08-30T14:04:00.000Z" }),
    ];

    const { minuteDeltas } = aggregateDeltas(events);

    expect(minuteDeltas).toHaveLength(2);
    expect(minuteDeltas.map((d) => d.bucket.toISOString())).toEqual([
      "2026-08-30T14:03:00.000Z",
      "2026-08-30T14:04:00.000Z",
    ]);
  });

  it("splits events into separate cells across the 5 dimensions", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", providerId: "adyen" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", providerId: "stripe" }),
    ];

    const { minuteDeltas } = aggregateDeltas(events);

    expect(minuteDeltas).toHaveLength(2);
  });

  it("produces a decline delta only for DECLINED events, counted per decline_code", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", status: "SUCCESS" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", status: "DECLINED", declineCode: "05" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000003", status: "DECLINED", declineCode: "05" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000004", status: "DECLINED", declineCode: "91" }),
    ];

    const { declineDeltas } = aggregateDeltas(events);

    expect(declineDeltas).toHaveLength(2);
    expect(declineDeltas.find((d) => d.declineCode === "05")).toMatchObject({ count: 2 });
    expect(declineDeltas.find((d) => d.declineCode === "91")).toMatchObject({ count: 1 });
  });

  it("throws if a DECLINED event has no declineCode (contract should have already rejected this upstream)", () => {
    const events = [
      baseEvent({ status: "DECLINED", declineCode: null }),
    ];

    expect(() => aggregateDeltas(events)).toThrow();
  });
});
