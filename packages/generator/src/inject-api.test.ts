import { describe, expect, it } from "vitest";

import { buildGeneratorCatalog } from "./catalog.ts";
import { createGenerator } from "./engine.ts";
import { buildInjectApi } from "./inject-api.ts";

const trafficWeights = {
  AR_STORE_01: 1,
  AR_STORE_02: 1,
  AR_STORE_03: 1,
  BR_STORE_01: 1,
  BR_STORE_02: 1,
  BR_STORE_03: 1,
  MX_STORE_01: 1,
  MX_STORE_02: 1,
  MX_STORE_03: 1,
};

function freshGenerator() {
  return createGenerator({ catalog: buildGeneratorCatalog(), trafficWeights });
}

describe("buildInjectApi", () => {
  it("adds a valid incident and lists it as active", async () => {
    const generator = freshGenerator();
    const app = buildInjectApi(generator);

    const postResponse = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: {
        id: "provider-br",
        startsAt: "2026-08-30T14:00:00.000Z",
        dimensions: { providerId: "adyen", country: "BR" },
        conversionMultiplier: 0.5,
      },
    });

    expect(postResponse.statusCode).toBe(201);
    expect(generator.activeIncidents()).toHaveLength(1);

    const getResponse = await app.inject({ method: "GET", url: "/incidents" });
    expect(getResponse.json()).toHaveLength(1);
  });

  it("rejects an invalid incident payload with 400 and does not add it", async () => {
    const generator = freshGenerator();
    const app = buildInjectApi(generator);

    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: { id: "bad", conversionMultiplier: 5 },
    });

    expect(response.statusCode).toBe(400);
    expect(generator.activeIncidents()).toHaveLength(0);
  });

  it("rejects a dimension outside the six canonical ones with 400", async () => {
    const generator = freshGenerator();
    const app = buildInjectApi(generator);

    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: {
        id: "bad-dimension",
        startsAt: "2026-08-30T14:00:00.000Z",
        dimensions: { cardBrand: "Visa" },
        conversionMultiplier: 0.5,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("removes an incident by id, returning 404 for an id that doesn't exist", async () => {
    const generator = freshGenerator();
    const app = buildInjectApi(generator);

    generator.addIncident({
      id: "provider-br",
      startsAt: "2026-08-30T14:00:00.000Z",
      dimensions: { providerId: "adyen" },
      conversionMultiplier: 0.5,
    });

    const deleteResponse = await app.inject({ method: "DELETE", url: "/incidents/provider-br" });
    expect(deleteResponse.statusCode).toBe(204);
    expect(generator.activeIncidents()).toHaveLength(0);

    const missingResponse = await app.inject({ method: "DELETE", url: "/incidents/does-not-exist" });
    expect(missingResponse.statusCode).toBe(404);
  });
});
