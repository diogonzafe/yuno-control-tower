import { describe, expect, it } from "vitest";
import type { ConfirmedDrop, EvidenceObject } from "@control-tower/contracts";
import type { RollupSource } from "../db/queries.js";
import type { RollupRow } from "../detect/types.js";
import { createEvidenceStore } from "./evidence-store.js";
import { createSignalStore } from "./signal-store.js";
import { createSseHub } from "./sse.js";
import { buildServer } from "./server.js";

const signal: ConfirmedDrop = {
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
  windowBucket: "2026-08-30T14:06:00.000Z", observedRate: 0.41, expectedRate: 0.95,
  expectedSource: "cross_sectional", deltaPp: 3, ciLow: 0.36, ciHigh: 0.46,
  ciLevel: 0.95, attempts: 420, approved: 172, windowUsed: "1m",
  startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true, consecutiveWindows: 3,
};

function historyRow(bucket: string, attempts: number, approved: number): RollupRow {
  return {
    bucket, merchantId: "BR_STORE_01", providerId: "adyen", country: "BR",
    paymentMethod: "CARD", issuerId: "itau", attempts, approved,
    amountMinorSum: attempts * 50, amountUsdSum: attempts * 10, approvedUsdSum: approved * 10,
  };
}

function build(overrides: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const store = createSignalStore();
  const evidenceStore = createEvidenceStore();
  const hub = createSseHub();
  const source: RollupSource = {
    getWindowRollups: async () => [],
    getHistory: async () => [
      historyRow("2026-08-30T14:05:00.000Z", 100, 95),
      historyRow("2026-08-30T14:06:00.000Z", 100, 40),
    ],
  };
  const app = buildServer({
    store, evidenceStore, hub, source,
    getSchedulerStatus: () => ({
      lastTickAt: "2026-08-30T14:07:10.000Z",
      lastProcessedBucket: "2026-08-30T14:06:00.000Z",
      bucketLagMinutes: 1,
      lastError: null,
    }),
    isIngestUp: () => true,
    ...overrides,
  });
  return { app, store, evidenceStore, hub };
}

describe("GET /health", () => {
  it("reports scheduler and ingest state", async () => {
    const { app } = build();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      ingest: "up",
      lastProcessedBucket: "2026-08-30T14:06:00.000Z",
      bucketLagMinutes: 1,
      sseConnections: 0,
    });
  });

  it("reports degraded when the scheduler recorded an error", async () => {
    const { app } = build({
      getSchedulerStatus: () => ({
        lastTickAt: "2026-08-30T14:07:10.000Z",
        lastProcessedBucket: "2026-08-30T14:06:00.000Z",
        bucketLagMinutes: 9,
        lastError: "connection lost",
      }),
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.json()).toMatchObject({ status: "degraded", lastError: "connection lost" });
  });
});

describe("GET /api/signals", () => {
  it("returns the buffered signals, newest first", async () => {
    const { app, store } = build();
    store.addSignals([signal]);

    const response = await app.inject({ method: "GET", url: "/api/signals" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0].windowBucket).toBe("2026-08-30T14:06:00.000Z");
  });

  it("honours ?limit=", async () => {
    const { app, store } = build();
    store.addSignals([signal, { ...signal, windowBucket: "2026-08-30T14:07:00.000Z" }]);

    const response = await app.inject({ method: "GET", url: "/api/signals?limit=1" });

    expect(response.json()).toHaveLength(1);
  });

  it("rejects a non-numeric limit with 400", async () => {
    const { app } = build();

    const response = await app.inject({ method: "GET", url: "/api/signals?limit=abc" });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/evidence", () => {
  it("returns the buffered evidence, newest first", async () => {
    const { app, evidenceStore } = build();
    const item: EvidenceObject = {
      fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#05",
      dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
      observedRate: 0.41, expectedRate: 0.95, expectedSource: "cross_sectional", deltaPp: 3,
      ci: { low: 0.36, high: 0.46, level: 0.95 }, attempts: 420, approved: 172,
      windowBucket: "2026-08-30T14:06:00.000Z", windowUsed: "1m", consecutiveWindows: 3,
      startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true,
      declineMix: [], dominantDecline: "05", suppressedEchoes: [],
      lostApprovals: 244, costUsdMinor: 24_400, costUsdPerMin: 8_133,
      costLocal: { BRL: 122_000 }, priorityScore: 8_133,
      diagnosisSource: "beam_search", investigationTrail: [],
    };
    evidenceStore.add([item]);

    const response = await app.inject({ method: "GET", url: "/api/evidence" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0].fingerprint).toBe(item.fingerprint);
  });

  it("honours ?limit=", async () => {
    const { app, evidenceStore } = build();
    const item: EvidenceObject = {
      fingerprint: "a", dimensions: {}, observedRate: 0.4, expectedRate: 0.9,
      expectedSource: "absolute", deltaPp: 3, ci: { low: 0.3, high: 0.5, level: 0.95 },
      attempts: 10, approved: 4, windowBucket: "2026-08-30T14:06:00.000Z", windowUsed: "1m",
      consecutiveWindows: 3, startedAt: "2026-08-30T14:03:00.000Z", startedAtExact: true,
      declineMix: [], dominantDecline: null, suppressedEchoes: [], lostApprovals: 1,
      costUsdMinor: 1, costUsdPerMin: 1, costLocal: {}, priorityScore: 1,
      diagnosisSource: "beam_search", investigationTrail: [],
    };
    evidenceStore.add([item, { ...item, fingerprint: "b" }]);

    const response = await app.inject({ method: "GET", url: "/api/evidence?limit=1" });

    expect(response.json()).toHaveLength(1);
  });
});

describe("GET /api/evidence-gaps", () => {
  it("returns the buffered gaps", async () => {
    const { app, store } = build();
    store.addGaps([{
      dimensions: { merchantId: "MX_STORE_01", country: "MX" },
      windowBucket: "2026-08-30T14:06:00.000Z", attempts: 7, reason: "INSUFFICIENT_EVIDENCE",
    }]);

    const response = await app.inject({ method: "GET", url: "/api/evidence-gaps" });

    expect(response.json()).toHaveLength(1);
    expect(response.json()[0].reason).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("GET /api/conversion", () => {
  it("returns one point per bucket with the observed rate", async () => {
    const { app } = build();

    const response = await app.inject({
      method: "GET",
      url: "/api/conversion?from=2026-08-30T14:00:00.000Z&to=2026-08-30T14:10:00.000Z",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { bucket: "2026-08-30T14:05:00.000Z", attempts: 100, approved: 95, rate: 0.95 },
      { bucket: "2026-08-30T14:06:00.000Z", attempts: 100, approved: 40, rate: 0.4 },
    ]);
  });

  it("filters by dimension", async () => {
    const { app } = build();

    const response = await app.inject({
      method: "GET",
      url: "/api/conversion?from=2026-08-30T14:00:00.000Z&to=2026-08-30T14:10:00.000Z&providerId=stripe",
    });

    expect(response.json()).toEqual([
      { bucket: "2026-08-30T14:05:00.000Z", attempts: 0, approved: 0, rate: null },
      { bucket: "2026-08-30T14:06:00.000Z", attempts: 0, approved: 0, rate: null },
    ]);
  });

  it("rejects a missing from/to with 400", async () => {
    const { app } = build();

    const response = await app.inject({ method: "GET", url: "/api/conversion" });

    expect(response.statusCode).toBe(400);
  });
});
