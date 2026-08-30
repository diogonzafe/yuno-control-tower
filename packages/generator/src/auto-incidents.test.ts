import { describe, expect, it } from "vitest";

import { buildGeneratorCatalog } from "./catalog.ts";
import { pickAutoIncidents } from "./auto-incidents.ts";
import { createSeededRandom } from "./random.ts";

describe("pickAutoIncidents", () => {
  it("returns exactly `count` incidents, each targeting a real provider or issuer id", () => {
    const catalog = buildGeneratorCatalog();
    const now = new Date("2026-08-30T14:00:00.000Z");

    const incidents = pickAutoIncidents(catalog, 3, createSeededRandom(1), now);

    expect(incidents).toHaveLength(3);
    for (const incident of incidents) {
      expect(incident.startsAt).toBe(now.toISOString());
      expect(incident.endsAt).toBeUndefined();
      expect(incident.conversionMultiplier).toBeGreaterThanOrEqual(0.3);
      expect(incident.conversionMultiplier).toBeLessThanOrEqual(0.6);

      const keys = Object.keys(incident.dimensions);
      expect(keys).toHaveLength(1);
      if (keys[0] === "providerId") {
        expect(catalog.providers.some((provider) => provider.providerId === incident.dimensions.providerId)).toBe(
          true,
        );
      } else {
        expect(keys[0]).toBe("issuerId");
        expect(catalog.issuers.some((issuer) => issuer.issuerId === incident.dimensions.issuerId)).toBe(true);
      }
    }
  });

  it("returns distinct ids for every incident", () => {
    const catalog = buildGeneratorCatalog();
    const incidents = pickAutoIncidents(catalog, 5, createSeededRandom(2), new Date());

    expect(new Set(incidents.map((incident) => incident.id)).size).toBe(5);
  });

  it("returns an empty array for count 0", () => {
    const catalog = buildGeneratorCatalog();

    expect(pickAutoIncidents(catalog, 0, createSeededRandom(1), new Date())).toEqual([]);
  });

  it("rejects a negative or non-integer count", () => {
    const catalog = buildGeneratorCatalog();
    const random = createSeededRandom(1);

    expect(() => pickAutoIncidents(catalog, -1, random, new Date())).toThrow(/non-negative integer/);
    expect(() => pickAutoIncidents(catalog, 1.5, random, new Date())).toThrow(/non-negative integer/);
  });
});
