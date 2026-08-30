import { describe, expect, it } from "vitest";

import { applyIncidents } from "./incident.ts";

describe("applyIncidents", () => {
  it("only affects a transaction in its scoped dimensions", () => {
    const incidents = [{
      id: "provider-br",
      startsAt: "2026-08-30T12:00:00.000Z",
      dimensions: { providerId: "adyen", country: "BR" as const },
      conversionMultiplier: 0.5,
      latencyMsIncrease: 200,
      declineWeights: { "91": 1 },
    }];

    const affected = applyIncidents(incidents, {
      at: "2026-08-30T12:01:00.000Z",
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    });
    const unaffected = applyIncidents(incidents, {
      at: "2026-08-30T12:01:00.000Z",
      merchantId: "BR_STORE_01",
      providerId: "stripe",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    });

    expect(affected.conversionMultiplier).toBe(0.5);
    expect(affected.latencyMsIncrease).toBe(200);
    expect(affected.declineWeights).toEqual({ "91": 1 });
    expect(unaffected.conversionMultiplier).toBe(1);
    expect(unaffected.latencyMsIncrease).toBe(0);
    expect(unaffected.declineWeights).toEqual({});
  });

  it("ignores an incident outside its active time window", () => {
    const incidents = [{
      id: "provider-br",
      startsAt: "2026-08-30T12:00:00.000Z",
      endsAt: "2026-08-30T12:10:00.000Z",
      dimensions: { providerId: "adyen" },
      conversionMultiplier: 0.5,
    }];

    const beforeStart = applyIncidents(incidents, {
      at: "2026-08-30T11:59:59.000Z",
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    });
    const afterEnd = applyIncidents(incidents, {
      at: "2026-08-30T12:10:00.000Z",
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    });

    expect(beforeStart.conversionMultiplier).toBe(1);
    expect(afterEnd.conversionMultiplier).toBe(1);
  });
});
