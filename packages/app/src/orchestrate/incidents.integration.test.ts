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

// A cell owned by one fingerprint alone. openOrUpdate recognises a live
// incident by its cell now, so the fixed `BR_STORE_01` this fixture used to
// carry would make every test in this file — and the real BR_STORE_01 rows the
// shared database already holds — look like one ongoing incident.
function cellOf(merchantId: string): EvidenceObject["dimensions"] {
  return {
    merchantId,
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
  };
}

function evidenceFixture(
  fingerprint: string,
  windowBucket: string,
  dimensions: EvidenceObject["dimensions"] = cellOf(fingerprint),
): EvidenceObject {
  return {
    fingerprint,
    dimensions,
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

  // The three fixes that preceded this one all chased the same symptom from the
  // key's side: pick a steadier dominant code, then let there be no code at all.
  // Both only moved where the key churns. The diagnosis behind the key is
  // re-derived from one minute of rollups every tick — the decline code by a
  // Wilson bound (decline-mix.ts) and the cell itself by a 2% concentration band
  // (parsimony.ts) — so no exact key is stable, and matching by exact equality
  // is what retires a live incident and opens its replacement.
  //
  // Measured on the real outage of 2026-09-04 17:19-18:02: one cell flat at ~13%
  // for 44 minutes with ~35 attempts a minute produced seven incidents, each
  // resolved after exactly RESOLVE_AFTER_QUIET_WINDOWS, every one of them
  // carrying the same started_at.
  it("reconfirms in place when the dominant decline code changes", async () => {
    const writer = createIncidentWriter();
    const merchantId = `test-${randomUUID()}`;

    const withCode = evidenceFixture(`${merchantId}#05`, BUCKET_1, cellOf(merchantId));
    const first = await writer.openOrUpdate({ ...withCode, dominantDecline: "05" });
    created.push(first.incidentId);

    // Same cell, same fault, one decline short of the Wilson bound.
    const bare = evidenceFixture(merchantId, BUCKET_2, cellOf(merchantId));
    const second = await writer.openOrUpdate({ ...bare, dominantDecline: null });
    created.push(second.incidentId);

    expect(second.incidentId).toBe(first.incidentId);
    expect(second.status).toBe("monitoring");
  });

  it("reconfirms in place when the peel settles one level deeper", async () => {
    const writer = createIncidentWriter();
    const merchantId = `test-${randomUUID()}`;
    const provider: EvidenceObject["dimensions"] =
      { merchantId, country: "BR", paymentMethod: "CARD", providerId: "stripe" };

    const first = await writer.openOrUpdate(
      evidenceFixture(`test-${randomUUID()}`, BUCKET_1, provider),
    );
    created.push(first.incidentId);

    const second = await writer.openOrUpdate(
      evidenceFixture(`test-${randomUUID()}`, BUCKET_2, { ...provider, issuerId: "itau" }),
    );
    created.push(second.incidentId);

    expect(second.incidentId).toBe(first.incidentId);

    // The incident sharpens as the evidence does: the row now names the issuer.
    const [row] = await db.select().from(incidents).where(eq(incidents.incidentId, first.incidentId));
    expect((row?.dimensions as Record<string, string>).issuerId).toBe("itau");
  });

  // spec.md §4 criterion 5: two simultaneous causes under one merchant are two
  // incidents. Compatibility must not collapse them.
  it("opens a second incident for an incompatible cell under the same root", async () => {
    const writer = createIncidentWriter();
    const merchantId = `test-${randomUUID()}`;
    const root: EvidenceObject["dimensions"] = { merchantId, country: "BR", paymentMethod: "CARD" };

    const stripe = await writer.openOrUpdate(
      evidenceFixture(`test-${randomUUID()}`, BUCKET_1, {
        ...root,
        providerId: "stripe",
        issuerId: "itau",
      }),
    );
    created.push(stripe.incidentId);

    const adyen = await writer.openOrUpdate(
      evidenceFixture(`test-${randomUUID()}`, BUCKET_1, {
        ...root,
        providerId: "adyen",
        issuerId: "nubank",
      }),
    );
    created.push(adyen.incidentId);

    expect(adyen.incidentId).not.toBe(stripe.incidentId);
    expect(adyen.status).toBe("open");
  });

  // The root-level INCONCLUSIVE branch of runDiagnosis sees the same fault from
  // further away. It is not a third card on the operator's screen — it is what
  // opened at 18:03 on the day the outage ended.
  it("does not open a third incident when a coarser diagnosis arrives", async () => {
    const writer = createIncidentWriter();
    const merchantId = `test-${randomUUID()}`;
    const root: EvidenceObject["dimensions"] = { merchantId, country: "BR" };

    const stripe = await writer.openOrUpdate(
      evidenceFixture(`test-${randomUUID()}`, BUCKET_1, {
        ...root,
        paymentMethod: "CARD",
        providerId: "stripe",
        issuerId: "itau",
      }),
    );
    created.push(stripe.incidentId);

    const coarse = await writer.openOrUpdate(evidenceFixture(`test-${randomUUID()}`, BUCKET_2, root));
    created.push(coarse.incidentId);

    expect(coarse.incidentId).toBe(stripe.incidentId);

    const live = await db
      .select()
      .from(incidents)
      .where(inArray(incidents.incidentId, [stripe.incidentId, coarse.incidentId]));
    expect(live).toHaveLength(1);
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
      evidence: evidenceFixture(fingerprint, BUCKET_1),
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

  // The whole point of the agent path: the panel reads incidents.evidence, so
  // an investigation that never lands there renders as a deterministic one.
  it("stores the agent's evidence and keeps it across the next tick", async () => {
    const writer = createIncidentWriter();
    const fingerprint = `test-${randomUUID()}`;
    const opened = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_1));
    created.push(opened.incidentId);

    const agentEvidence: EvidenceObject = {
      ...evidenceFixture(fingerprint, BUCKET_1),
      diagnosisSource: "agent",
      investigationTrail: [],
    };
    await writer.attachNarrative({
      incidentId: opened.incidentId,
      evidence: agentEvidence,
      narrativeOps: "CARD is degraded at BR_STORE_01.",
      narrativeExec: "Escalate to the rail owner.",
      playbookId: "method-country-default",
    });

    const [enriched] = await db.select().from(incidents).where(eq(incidents.incidentId, opened.incidentId));
    expect((enriched?.evidence as EvidenceObject).diagnosisSource).toBe("agent");

    // The drop re-confirms every minute while the incident is live. Before the
    // guard in openOrUpdate this tick reverted the column to "beam_search",
    // which is why a successful investigation still rendered as deterministic.
    const reconfirmed = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_2));
    expect(reconfirmed.incidentId).toBe(opened.incidentId);

    const [after] = await db.select().from(incidents).where(eq(incidents.incidentId, opened.incidentId));
    expect((after?.evidence as EvidenceObject).diagnosisSource).toBe("agent");
    // The measured columns still track the live window.
    expect(after?.detectedAt.toISOString()).toBe(BUCKET_2);
  });

  // A restart re-investigates every live incident, so a second run can land
  // after a first one already succeeded. If that second run falls back, its
  // deterministic object must not undo the finished investigation.
  it("does not let a later fallback downgrade an agent-enriched incident", async () => {
    const writer = createIncidentWriter();
    const fingerprint = `test-${randomUUID()}`;
    const opened = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_1));
    created.push(opened.incidentId);

    await writer.attachNarrative({
      incidentId: opened.incidentId,
      evidence: { ...evidenceFixture(fingerprint, BUCKET_1), diagnosisSource: "agent" },
      narrativeOps: "agent narrative",
      narrativeExec: "agent exec",
      playbookId: "method-country-default",
    });

    await writer.attachNarrative({
      incidentId: opened.incidentId,
      evidence: { ...evidenceFixture(fingerprint, BUCKET_2), diagnosisSource: "beam_search" },
      narrativeOps: "fallback narrative",
      narrativeExec: "fallback exec",
      playbookId: "provider-default",
    });

    const [after] = await db.select().from(incidents).where(eq(incidents.incidentId, opened.incidentId));
    expect((after?.evidence as EvidenceObject).diagnosisSource).toBe("agent");
    // The triple stays together: dropping the evidence but keeping the text
    // would leave a narrative describing a diagnosis the row no longer holds.
    expect(after?.narrativeOps).toBe("agent narrative");
    expect(after?.playbookId).toBe("method-country-default");
  });

  // An agent that settles on a peeled sibling's cell produces an object keyed
  // by the sibling's fingerprint. It belongs to that row, not this one.
  it("keeps the deterministic evidence when the agent's object is for another cell", async () => {
    const writer = createIncidentWriter();
    const fingerprint = `test-${randomUUID()}`;
    const opened = await writer.openOrUpdate(evidenceFixture(fingerprint, BUCKET_1));
    created.push(opened.incidentId);

    await writer.attachNarrative({
      incidentId: opened.incidentId,
      evidence: { ...evidenceFixture(`test-${randomUUID()}`, BUCKET_1), diagnosisSource: "agent" },
      narrativeOps: "ops",
      narrativeExec: "exec",
      playbookId: null,
    });

    const [after] = await db.select().from(incidents).where(eq(incidents.incidentId, opened.incidentId));
    expect((after?.evidence as EvidenceObject).fingerprint).toBe(fingerprint);
    expect((after?.evidence as EvidenceObject).diagnosisSource).toBe("beam_search");
    expect(after?.narrativeOps).toBe("ops");
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
