import assert from "node:assert/strict";
import test from "node:test";

import { defaultGeneratorCatalog } from "./catalog.ts";
import { createGenerator } from "./engine.ts";
import { createSeededRandom } from "./random.ts";

test("generator selects only covered cells and respects merchant traffic weights", () => {
  const generator = createGenerator({
    catalog: defaultGeneratorCatalog,
    trafficWeights: { "merchant-a": 3, "merchant-b": 2, "merchant-c": 1 },
    random: createSeededRandom(7),
  });
  const counts = new Map<string, number>();

  for (let index = 0; index < 10_000; index += 1) {
    const event = generator.next(new Date("2026-08-30T12:00:00.000Z"));
    counts.set(event.merchantId, (counts.get(event.merchantId) ?? 0) + 1);
    assert.ok(event.paymentMethod !== "PIX" || (event.country === "BR" && event.issuerId === "NA"));
  }

  assert.ok(counts.get("merchant-a")! > counts.get("merchant-b")!);
  assert.ok(counts.get("merchant-b")! > counts.get("merchant-c")!);
});

test("generator applies and removes an injected incident", () => {
  const generator = createGenerator({
    catalog: defaultGeneratorCatalog,
    trafficWeights: { "merchant-a": 1, "merchant-b": 1, "merchant-c": 1 },
    random: createSeededRandom(11),
  });
  const incident = {
    id: "provider-br",
    startsAt: "2026-08-30T12:00:00.000Z",
    dimensions: { providerId: "adyen", country: "BR" },
    conversionMultiplier: 0.5,
    declineWeights: { ISSUER_UNAVAILABLE: 1 },
  } as const;

  generator.addIncident(incident);
  assert.deepEqual(generator.activeIncidents(), [incident]);
  assert.equal(generator.removeIncident(incident.id), true);
  assert.deepEqual(generator.activeIncidents(), []);
});
