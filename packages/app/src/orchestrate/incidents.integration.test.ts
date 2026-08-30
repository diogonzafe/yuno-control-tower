import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { EvidenceObject } from "@control-tower/contracts";
import { db } from "../db/client";
import { incidents } from "../db/schema";
import { createIncidentWriter } from "./incidents";

// A minute no real or demo-generated transaction can ever fall into: this suite
// writes to the shared production-shape database, which holds ~90k real
// retroactive rows.
//
// Far future rather than the epoch, unlike the suites that call reconcile. This
// one only opens incidents and then asserts their status, and lifecycle.ts
// selects EVERY active incident with no time bound: an app running against the
// same database reconciles at a bucket of today, counts millions of quiet
// windows against a 1970 detected_at and resolves these rows out from under the
// assertions. With detected_at in 2999 the count is negative, so planTransitions
// skips them and no live process can touch them.
const BUCKET_1 = "2999-01-01T00:10:00.000Z";
const BUCKET_2 = "2999-01-01T00:11:00.000Z";
const STARTED_AT = "2999-01-01T00:07:00.000Z";

const created: string[] = [];

function evidenceFixture(fingerprint: string, windowBucket: string): EvidenceObject {
  return {
    fingerprint,
    dimensions: {
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
    },
    observedRate: 0.51,
    expectedRate: 0.92,
    expectedSource: "cross_sectional",
    deltaPp: 41,
    ci: { low: 0.47, high: 0.55, level: 0.95 },
    attempts: 420,
    approved: 214,
    windowBucket,
    windowUsed: "1m",
    consecutiveWindows: 3,
    startedAt: STARTED_AT,
    startedAtExact: true,
    declineMix: [],
    dominantDecline: "91",
    suppressedEchoes: [],
    lostApprovals: 173,
    costUsdMinor: 481200,
    costUsdPerMin: 160400,
    costLocal: { BRL: 2500000 },
    priorityScore: 88.2,
    diagnosisSource: "beam_search",
    investigationTrail: [],
  };
}

afterEach(async () => {
  if (created.length > 0) {
    // Scoped to the exact ids this suite generated — never a broad delete.
    await db.delete(incidents).where(inArray(incidents.incidentId, created));
    created.length = 0;
  }
});

describe("incident writer", () => {
  it("opens once and reconfirms in place, bumping detectedAt", async () => {
    const writer = createIncidentWriter();
    const fingerprint = `test-${randomUUID()}`;

    const first = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_1));
    created.push(first.incidentId);
    expect(first.status).toBe("open");

    const second = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_2));
    // Same live incident, not a second card on the operator's screen.
    expect(second.incidentId).toBe(first.incidentId);
    expect(second.status).toBe("monitoring");

    const rows = await db.select().from(incidents).where(eq(incidents.fingerprint, fingerprint));
    expect(rows).toHaveLength(1);
    // lifecycle.ts derives "quiet windows" from detectedAt, so the bump is the
    // whole mechanism that keeps a live incident from being auto-resolved.
    expect(rows[0]?.detectedAt.toISOString()).toBe(BUCKET_2);
    expect(rows[0]?.status).toBe("monitoring");
  });

  it("opens a new incident when the previous one with the same fingerprint is resolved", async () => {
    const writer = createIncidentWriter();
    const fingerprint = `test-${randomUUID()}`;

    const first = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_1));
    created.push(first.incidentId);
    await db
      .update(incidents)
      .set({ status: "resolved", resolvedAt: new Date(BUCKET_1) })
      .where(eq(incidents.incidentId, first.incidentId));

    const second = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_2));
    created.push(second.incidentId);

    // A recurrence is a NEW incident. Without this, memory.ts would never have
    // a resolved sibling to recall (spec.md §5 repetition bonus).
    expect(second.incidentId).not.toBe(first.incidentId);
    expect(second.status).toBe("open");
  });

  it("attaches narrative without touching any measured field", async () => {
    const writer = createIncidentWriter();
    const fingerprint = `test-${randomUUID()}`;
    const opened = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_1));
    created.push(opened.incidentId);

    const [before] = await db.select().from(incidents).where(eq(incidents.incidentId, opened.incidentId));

    await writer.attachNarrative({
      incidentId: opened.incidentId,
      narrativeOps: "Provider adyen is degraded in BR.",
      narrativeExec: "Escalate to provider-ops.",
      playbookId: "provider-default",
    });

    const [after] = await db.select().from(incidents).where(eq(incidents.incidentId, opened.incidentId));
    expect(after?.narrativeOps).toBe("Provider adyen is degraded in BR.");
    expect(after?.playbookId).toBe("provider-default");
    // rules.md §3 boundary #2: the narrator verbalizes, it never recomputes.
    expect(after?.currentRate).toBe(before?.currentRate);
    expect(after?.costUsdMinor).toBe(before?.costUsdMinor);
    expect(after?.status).toBe(before?.status);
    expect(after?.detectedAt.toISOString()).toBe(before?.detectedAt.toISOString());
  });

  // priority_score was numeric(10,4), so anything past 999999.9999 minor units
  // per minute — a hair under $10k/min — failed the INSERT with "numeric field
  // overflow". The incidents that hit it are by definition the most expensive
  // ones, and they never opened.
  it("opens an incident costing far more than $10k per minute", async () => {
    const writer = createIncidentWriter();
    const fingerprint = `test-${randomUUID()}`;
    const evidence = evidenceFixture(fingerprint, BUCKET_1);

    const opened = await writer.openOrUpdate({
      ...evidence,
      costUsdMinor: 15_000_000,
      costUsdPerMin: 5_000_000, // $50k/min
      priorityScore: 5_000_000,
    });
    created.push(opened.incidentId);

    const [row] = await db.select().from(incidents).where(eq(incidents.incidentId, opened.incidentId));
    expect(row?.priorityScore).toBe("5000000.0000");
  });
});
