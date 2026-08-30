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

  it("emits a tick's batch concurrently, so a slow sink does not cap throughput at 1/latency", async () => {
    vi.useFakeTimers();
    const generator = createGenerator({
      catalog: buildGeneratorCatalog(),
      trafficWeights: equalTrafficWeights,
      random: createSeededRandom(5),
    });

    let inFlight = 0;
    let peakInFlight = 0;
    const sink = async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Every sink call is a network round trip in production; awaiting them
      // one at a time is exactly the regression this test pins down.
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
    };

    const runtime = startGenerator(generator, sink, {
      baseTps: 30,
      tickMilliseconds: 1_000,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    runtime.stop();

    // Sequential awaiting would never exceed one in-flight call.
    expect(peakInFlight).toBeGreaterThan(1);
  });

  it("caps the carried backlog instead of queueing unboundedly behind a stalled sink", async () => {
    vi.useFakeTimers();
    const generator = createGenerator({
      catalog: buildGeneratorCatalog(),
      trafficWeights: equalTrafficWeights,
      random: createSeededRandom(7),
    });

    let emitted = 0;
    let release: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const sink = async () => {
      emitted += 1;
      await stalled;
    };

    const runtime = startGenerator(generator, sink, {
      baseTps: 60,
      tickMilliseconds: 100,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    // Five minutes of ticks against a sink that never settles. Uncapped, carry
    // would accumulate ~18,000 events; the cap holds it to MAX_CARRY_EVENTS.
    await vi.advanceTimersByTimeAsync(300_000);
    release!();
    await vi.advanceTimersByTimeAsync(100);
    runtime.stop();

    // Five minutes at 60 TPS is ~18,000 events; uncapped, every one of them
    // would still be queued. What actually lands is the cap (600) plus the
    // first tick's own batch, which drained before the sink stalled — bounded
    // by MAX_CARRY_EVENTS, not by elapsed time.
    expect(emitted).toBeLessThan(700);
  });

  it("timestamps each event as it is emitted, not once per tick", async () => {
    vi.useFakeTimers();
    const generator = createGenerator({
      catalog: buildGeneratorCatalog(),
      trafficWeights: equalTrafficWeights,
      random: createSeededRandom(11),
    });

    let clock = new Date("2026-08-30T12:00:00.000Z").getTime();
    const seen: string[] = [];
    const sink = async (event: { createdAt: string }) => {
      seen.push(event.createdAt);
      // Time moves while the batch drains, as it does against a real sink.
      clock += 1_000;
    };

    const runtime = startGenerator(generator, sink, {
      baseTps: 30,
      tickMilliseconds: 1_000,
      now: () => new Date(clock),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    runtime.stop();

    // A single `at` captured at tick start would make every event identical.
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});
