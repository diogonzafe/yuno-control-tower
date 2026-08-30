import type { GeneratorCatalog } from "./catalog.ts";
import type { GeneratorIncident } from "./incident.ts";
import type { SeededRandom } from "./random.ts";

const MIN_CONVERSION_MULTIPLIER = 0.3;
const MAX_CONVERSION_MULTIPLIER = 0.6;

/**
 * Picks `count` incidents to keep simultaneously active for the whole run,
 * without needing the injection API — useful for exercising the detector's
 * peeling/simultaneous-incident path (DD18) without a manual console.
 *
 * Each incident targets either a random provider or a random issuer (the two
 * most common roadmap scenarios: provider degradation, issuer outage), with a
 * conversionMultiplier in [0.3, 0.6] — a 40-70% relative drop, comfortably
 * material so the Wilson detector confirms it rather than staying in
 * MONITORING. Incidents have no `endsAt`: they stay active until the
 * generator process stops.
 */
export function pickAutoIncidents(
  catalog: GeneratorCatalog,
  count: number,
  random: SeededRandom,
  now: Date,
): GeneratorIncident[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("count must be a non-negative integer");
  }

  const incidents: GeneratorIncident[] = [];
  for (let index = 0; index < count; index += 1) {
    const dimensions = random.next() < 0.5
      ? { providerId: pickOne(catalog.providers, random).providerId }
      : { issuerId: pickOne(catalog.issuers, random).issuerId };

    incidents.push({
      id: `auto-${index}-${random.int(1_000_000)}`,
      startsAt: now.toISOString(),
      dimensions,
      conversionMultiplier:
        MIN_CONVERSION_MULTIPLIER + random.next() * (MAX_CONVERSION_MULTIPLIER - MIN_CONVERSION_MULTIPLIER),
    });
  }

  return incidents;
}

function pickOne<T>(values: readonly T[], random: SeededRandom): T {
  return values[random.int(values.length)]!;
}
