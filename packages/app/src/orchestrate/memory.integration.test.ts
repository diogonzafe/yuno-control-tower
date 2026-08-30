import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/client";
import { incidents } from "../db/schema";
import { createIncidentMemory } from "./memory";

// Far-future buckets, not the epoch: lifecycle.ts selects EVERY active incident
// with no time bound, so an app running against the same shared database would
// reconcile at a bucket of today and resolve the `monitoring` seed below — the
// one this suite requires memory NOT to recall. A detected_at in 2999 makes the
// quiet-window count negative, so no live reconcile can reach these rows.
const created: string[] = [];

async function seedIncident(input: {
  fingerprint: string;
  status: string;
  detectedAt: string;
  playbookId: string | null;
}): Promise<string> {
  const incidentId = randomUUID();
  await db.insert(incidents).values({
    incidentId,
    fingerprint: input.fingerprint,
    dimensions: { merchantId: "BR_STORE_01", providerId: "adyen", country: "BR" },
    dominantDecline: "91",
    status: input.status,
    ciLow: "0.47000",
    ciHigh: "0.55000",
    ciLevel: "0.950",
    startedAt: new Date("2999-01-01T00:07:00.000Z"),
    startedAtExact: true,
    detectedAt: new Date(input.detectedAt),
    resolvedAt: input.status === "resolved" ? new Date(input.detectedAt) : null,
    baselineRate: "0.92000",
    currentRate: "0.51000",
    lostApprovals: 173,
    costLocal: { BRL: 2500000 },
    costUsdMinor: 481200,
    costUsdPerMin: 160400,
    priorityScore: "88.2000",
    evidence: {},
    narrativeOps: null,
    narrativeExec: null,
    playbookId: input.playbookId,
  });
  created.push(incidentId);
  return incidentId;
}

afterEach(async () => {
  if (created.length > 0) {
    await db.delete(incidents).where(inArray(incidents.incidentId, created));
    created.length = 0;
  }
});

describe("incident memory", () => {
  it("recalls only resolved incidents sharing the exact fingerprint", async () => {
    const fingerprint = `test-${randomUUID()}`;
    const older = await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "2999-01-01T00:10:00.000Z",
      playbookId: "provider-default",
    });
    // Still live: not history yet, must not be recalled.
    await seedIncident({
      fingerprint,
      status: "monitoring",
      detectedAt: "2999-01-01T00:20:00.000Z",
      playbookId: "provider-default",
    });
    // A different cell entirely.
    await seedIncident({
      fingerprint: `test-${randomUUID()}`,
      status: "resolved",
      detectedAt: "2999-01-01T00:12:00.000Z",
      playbookId: "issuer-default",
    });

    const memory = createIncidentMemory();
    const recalled = await memory.recallByFingerprint({ fingerprint });

    expect(recalled.map((item) => item.incidentId)).toEqual([older]);
    expect(recalled[0]?.rootCauseDimension).toBe("provider");
    expect(recalled[0]?.fingerprint).toBe(fingerprint);
    expect(recalled[0]?.summary.length).toBeGreaterThan(0);
  });

  it("excludes the current incident and honours the limit", async () => {
    const fingerprint = `test-${randomUUID()}`;
    const current = await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "2999-01-01T00:30:00.000Z",
      playbookId: "provider-default",
    });
    await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "2999-01-01T00:20:00.000Z",
      playbookId: "provider-default",
    });
    await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "2999-01-01T00:10:00.000Z",
      playbookId: "provider-default",
    });

    const memory = createIncidentMemory();
    const recalled = await memory.recallByFingerprint({
      fingerprint,
      excludeIncidentId: current,
      limit: 1,
    });

    expect(recalled).toHaveLength(1);
    // Most recent first.
    expect(recalled[0]?.summary).toContain("2999-01-01T00:20");
  });

  it("returns a null root cause when no playbook matched", async () => {
    const fingerprint = `test-${randomUUID()}`;
    await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "2999-01-01T00:10:00.000Z",
      playbookId: null,
    });

    const memory = createIncidentMemory();
    const recalled = await memory.recallByFingerprint({ fingerprint });

    // The contract allows null. Guessing a dimension here would be invention.
    expect(recalled[0]?.rootCauseDimension).toBeNull();
  });
});
