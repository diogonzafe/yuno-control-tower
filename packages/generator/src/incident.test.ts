import assert from "node:assert/strict";
import test from "node:test";

import { applyIncidents } from "./incident.ts";

test("an incident only affects a transaction in its scoped dimensions", () => {
  const incidents = [{
    id: "provider-br",
    startsAt: "2026-08-30T12:00:00.000Z",
    dimensions: { providerId: "adyen", country: "BR" },
    conversionMultiplier: 0.5,
    latencyMsIncrease: 200,
    declineWeights: { ISSUER_UNAVAILABLE: 1 },
  }] as const;

  const affected = applyIncidents(incidents, {
    at: "2026-08-30T12:01:00.000Z",
    merchantId: "merchant-a",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
  });
  const unaffected = applyIncidents(incidents, {
    at: "2026-08-30T12:01:00.000Z",
    merchantId: "merchant-a",
    providerId: "stripe",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
  });

  assert.equal(affected.conversionMultiplier, 0.5);
  assert.equal(affected.latencyMsIncrease, 200);
  assert.deepEqual(affected.declineWeights, { ISSUER_UNAVAILABLE: 1 });
  assert.equal(unaffected.conversionMultiplier, 1);
  assert.equal(unaffected.latencyMsIncrease, 0);
  assert.deepEqual(unaffected.declineWeights, {});
});
