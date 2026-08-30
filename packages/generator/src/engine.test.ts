import { afterEach, describe, expect, it, vi } from "vitest";

import { buildGeneratorCatalog } from "./catalog.ts";
import { createGenerator, startGenerator } from "./engine.ts";
import { createSeededRandom } from "./random.ts";

const equalTrafficWeights = {
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

describe("createGenerator", () => {
  it("selects only covered cells and respects merchant traffic weights", () => {
    const generator = createGenerator({
      catalog: buildGeneratorCatalog(),
      trafficWeights: { ...equalTrafficWeights, BR_STORE_01: 3, BR_STORE_02: 2, BR_STORE_03: 1 },
      random: createSeededRandom(7),
    });
    const counts = new Map<string, number>();

    for (let index = 0; index < 10_000; index += 1) {
      const event = generator.next(new Date("2026-08-30T12:00:00.000Z"));
      counts.set(event.merchantId, (counts.get(event.merchantId) ?? 0) + 1);
      expect(event.paymentMethod !== "PIX" || (event.country === "BR" && event.issuerId === "NA")).toBe(true);
      expect(event.merchantId.startsWith(event.country)).toBe(true);
    }

    expect(counts.get("BR_STORE_01")!).toBeGreaterThan(counts.get("BR_STORE_02")!);
    expect(counts.get("BR_STORE_02")!).toBeGreaterThan(counts.get("BR_STORE_03")!);
  });

  it("applies and removes an injected incident", () => {
    const generator = createGenerator({
      catalog: buildGeneratorCatalog(),
      trafficWeights: equalTrafficWeights,
      random: createSeededRandom(11),
    });
    const incident = {
      id: "provider-br",
      startsAt: "2026-08-30T12:00:00.000Z",
      dimensions: { providerId: "adyen", country: "BR" as const },
      conversionMultiplier: 0.5,
      declineWeights: { "91": 1 },
    };

    generator.addIncident(incident);
    expect(generator.activeIncidents()).toEqual([incident]);
    expect(generator.removeIncident(incident.id)).toBe(true);
    expect(generator.activeIncidents()).toEqual([]);
  });
});

describe("startGenerator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops only the one sink call that throws, not the rest of that tick's batch, and never rejects unhandled", async () => {
    vi.useFakeTimers();
    const generator = createGenerator({
      catalog: buildGeneratorCatalog(),
      trafficWeights: equalTrafficWeights,
      random: createSeededRandom(3),
    });

    let callCount = 0;
    const succeeded: number[] = [];
    const sink = async () => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("simulated sink failure");
      }
      succeeded.push(callCount);
    };

    // baseTps=30 with a single 1000ms tick emits ~30 events in one batch —
    // enough to guarantee at least one call after the thrown one.
    const runtime = startGenerator(generator, sink, {
      baseTps: 30,
      tickMilliseconds: 1_000,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    await vi.advanceTimersByTimeAsync(1_000);
    runtime.stop();

    process.off("unhandledRejection", onUnhandledRejection);

    expect(callCount).toBeGreaterThan(2);
    // Call #2 threw and is absent; every other call in the batch still ran.
    expect(succeeded).not.toContain(2);
    expect(succeeded.length).toBe(callCount - 1);
    expect(unhandled).toEqual([]);
  });
});
