# Orchestrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `orchestrate/` — the module that owns writes to `incidents`, runs the incident lifecycle state machine, and recalls repeat incidents by exact fingerprint — and move incident persistence out of `agent/`.

**Architecture:** The scheduler's per-tick `onResult` already carries fully-formed `EvidenceObject[]`. `orchestrate/incidents.ts` writes them to `incidents` immediately and deterministically; `orchestrate/lifecycle.ts` reconciles what disappeared using `detected_at` as a derived quiet-window counter (no new column, no in-memory state); `orchestrate/memory.ts` reads resolved incidents back by fingerprint. The agent stops creating incidents and only enriches an existing row with narrative.

**Tech Stack:** TypeScript strict/ESM, Drizzle ORM over postgres.js, Zod contracts (`@control-tower/contracts`), Vitest, Fastify 5, pino. Node 22 via nvm.

**Spec:** `docs/superpowers/specs/2026-08-30-orchestrate-design.md` (YCT-ORCH-001)

## Global Constraints

- Repo root: `/Users/diogoferreira/hackathon/yuno-control-tower`. Branch: `dev`. All work happens in `packages/app`.
- Node 22 is required. Every shell command must start with `source ~/.nvm/nvm.sh && nvm use 22`. The sandbox default is Node 18 and cannot run Fastify 5.
- **No migrations.** The `incidents` table already has every column needed, including the `incidents_status_check` constraint restricting status to `'open','monitoring','resolved','inconclusive'`, and the `ix_incident_fingerprint` index. Do not run `drizzle-kit generate`.
- **No changes to `packages/contracts`.** All contracts are frozen.
- **The database holds ~90,000 real retroactive rows (2026-08-28 to 2026-08-29). Never delete them.** Integration tests write only to buckets at `1970-01-01` and delete only rows they created, scoped by full primary key or by the exact `incident_id` they generated.
- Never read, print, or commit values from `.env` (`DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY`). `AGENTS.md` forbids it.
- Code, identifiers, file names, commit messages and error messages in English. Comments explain non-obvious *why* and cite decisions (DD15, `rules.md` §3, `roadmap.md` §5); they never narrate what the code obviously does.
- `rules.md` §6.8: never issue one query per cell in series. Each lifecycle tick does at most one SELECT plus two UPDATEs, all set-based.
- `rules.md` §3 boundary #3: every agentic path has a deterministic fallback. After this plan, cutting `agent/` entirely must still leave incidents being created, updated and resolved.
- Test commands: `pnpm --filter @control-tower/app test` (all), `pnpm --filter @control-tower/app typecheck`. A single file: `pnpm --filter @control-tower/app exec vitest run src/orchestrate/lifecycle.test.ts`.

---

## File Structure

**Created:**
- `packages/app/src/orchestrate/incidents.ts` — the only module in the system that writes to the `incidents` table. Two operations: `openOrUpdate` (deterministic, tick-time) and `attachNarrative` (agentic enrichment).
- `packages/app/src/orchestrate/incidents.integration.test.ts`
- `packages/app/src/orchestrate/lifecycle.ts` — the state machine. A pure `planTransitions` function plus a `reconcile` that wraps it in exactly one SELECT and up to two UPDATEs.
- `packages/app/src/orchestrate/lifecycle.test.ts` — pure, no database.
- `packages/app/src/orchestrate/memory.ts` — exact-fingerprint recall (DD15).
- `packages/app/src/orchestrate/memory.integration.test.ts`
- `packages/app/src/orchestrate/index.ts` — barrel, matching the `agent/index.ts` pattern used by `run.ts`.

**Modified:**
- `packages/app/src/agent/persistence.ts` — remove `upsertIncidentFromEvidence` from the interface and both implementations. `agent/` keeps `investigation_runs` and `investigation_steps` only.
- `packages/app/src/agent/coordinator.ts` — `handleSignal` takes an `incidentId`; `persistOutcome` calls `attachNarrative` instead of creating an incident.
- `packages/app/src/run.ts` — wire `incidents.openOrUpdate` and `lifecycle.reconcile` into the scheduler's `onResult`, ahead of the coordinator.
- `packages/app/src/agent/coordinator.test.ts` — update for the new signature.

---

### Task 1: Incident writer

**Files:**
- Create: `packages/app/src/orchestrate/incidents.ts`
- Create: `packages/app/src/orchestrate/incidents.integration.test.ts`

**Interfaces:**
- Consumes: `EvidenceObject` from `@control-tower/contracts`; `db` from `../db/client.js`; `incidents` from `../db/schema.js`.
- Produces:
  - `type IncidentUpsert = { incidentId: string; status: "open" | "monitoring" }`
  - `type IncidentWriter = { openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert>; attachNarrative(input: { incidentId: string; narrativeOps: string | null; narrativeExec: string | null; playbookId: string | null }): Promise<void> }`
  - `function createIncidentWriter(database?: Database): IncidentWriter`

**Background the implementer needs:** the body of `openOrUpdate` is a move of `upsertIncidentFromEvidence` from `packages/app/src/agent/persistence.ts:449-503`, minus the three narrative fields and with a different return type. Read that function before writing this one — the numeric-column-to-string conversions (`.toString()` on every `numeric` column) are load-bearing: Drizzle types `numeric` without `mode` as `string`, and passing a JS number silently fails.

Do **not** delete the old function in this task. Task 4 removes it, so the build stays green in between.

- [ ] **Step 1: Write the failing integration test**

Create `packages/app/src/orchestrate/incidents.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { EvidenceObject } from "@control-tower/contracts";
import { db } from "../db/client";
import { incidents } from "../db/schema";
import { createIncidentWriter } from "./incidents";

// The epoch, deliberately: this suite writes to the shared production-shape
// database, which holds ~90k real retroactive rows. A 1970 bucket is a minute
// no real or demo-generated transaction can ever fall into.
const BUCKET_1 = "1970-01-01T00:10:00.000Z";
const BUCKET_2 = "1970-01-01T00:11:00.000Z";
const STARTED_AT = "1970-01-01T00:07:00.000Z";

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source ~/.nvm/nvm.sh && nvm use 22
cd /Users/diogoferreira/hackathon/yuno-control-tower
pnpm --filter @control-tower/app exec vitest run src/orchestrate/incidents.integration.test.ts
```

Expected: FAIL — `Failed to resolve import "./incidents"`.

- [ ] **Step 3: Implement the writer**

Create `packages/app/src/orchestrate/incidents.ts`:

```ts
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import type { EvidenceObject } from "@control-tower/contracts";
import { db as defaultDatabase } from "../db/client.js";
import { incidents } from "../db/schema.js";

type Database = typeof defaultDatabase;

export type IncidentUpsert = {
  incidentId: string;
  status: "open" | "monitoring";
};

export type IncidentWriter = {
  openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert>;
  attachNarrative(input: {
    incidentId: string;
    narrativeOps: string | null;
    narrativeExec: string | null;
    playbookId: string | null;
  }): Promise<void>;
};

// Every `numeric` column is typed as string by Drizzle (no `mode` set in
// db/schema.ts), so each one is converted explicitly. Passing a JS number here
// fails at the driver, not at the type checker.
function measuredColumns(evidence: EvidenceObject) {
  return {
    dimensions: evidence.dimensions,
    dominantDecline: evidence.dominantDecline,
    ciLow: evidence.ci.low.toString(),
    ciHigh: evidence.ci.high.toString(),
    ciLevel: evidence.ci.level.toString(),
    startedAt: new Date(evidence.startedAt),
    startedAtExact: evidence.startedAtExact,
    detectedAt: new Date(evidence.windowBucket),
    baselineRate: evidence.expectedRate.toString(),
    currentRate: evidence.observedRate.toString(),
    lostApprovals: evidence.lostApprovals,
    costLocal: evidence.costLocal,
    costUsdMinor: evidence.costUsdMinor,
    costUsdPerMin: evidence.costUsdPerMin,
    priorityScore: evidence.priorityScore.toString(),
    evidence,
  };
}

export function createIncidentWriter(database: Database = defaultDatabase): IncidentWriter {
  return {
    async openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert> {
      const [existing] = await database
        .select({ incidentId: incidents.incidentId })
        .from(incidents)
        .where(and(eq(incidents.fingerprint, evidence.fingerprint), ne(incidents.status, "resolved")))
        .orderBy(desc(incidents.detectedAt))
        .limit(1);

      if (existing) {
        // roadmap.md §5: `monitoring` updates without re-alerting, which is
        // what stops a three-hour incident from producing 36 alerts. The
        // detectedAt bump inside measuredColumns is what lifecycle.ts reads
        // as "still live".
        await database
          .update(incidents)
          .set({ ...measuredColumns(evidence), status: "monitoring" })
          .where(eq(incidents.incidentId, existing.incidentId));
        return { incidentId: existing.incidentId, status: "monitoring" };
      }

      const incidentId = randomUUID();
      await database.insert(incidents).values({
        incidentId,
        fingerprint: evidence.fingerprint,
        status: "open",
        resolvedAt: null,
        narrativeOps: null,
        narrativeExec: null,
        playbookId: null,
        ...measuredColumns(evidence),
      });
      return { incidentId, status: "open" };
    },

    async attachNarrative(input) {
      await database
        .update(incidents)
        .set({
          narrativeOps: input.narrativeOps,
          narrativeExec: input.narrativeExec,
          playbookId: input.playbookId,
        })
        .where(eq(incidents.incidentId, input.incidentId));
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @control-tower/app exec vitest run src/orchestrate/incidents.integration.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Verify no stray rows were left behind**

```bash
cd /Users/diogoferreira/hackathon/yuno-control-tower/packages/app && node -e '
import("dotenv").then(async (d)=>{ d.config({path:"../../.env"});
const {default:postgres}=await import("postgres");
const sql=postgres(process.env.DATABASE_URL,{ssl:"require"});
console.log(await sql`select count(*)::int c from incidents where fingerprint like ${"test-%"}`);
await sql.end();});'
```

Expected: `[{ c: 0 }]`. If it is not zero, the `afterEach` cleanup is broken — fix it before committing.

- [ ] **Step 6: Commit**

```bash
cd /Users/diogoferreira/hackathon/yuno-control-tower
git add packages/app/src/orchestrate/
git commit -m "feat(orchestrate): incident writer owning writes to incidents"
```

---

### Task 2: Lifecycle state machine

**Files:**
- Create: `packages/app/src/orchestrate/lifecycle.ts`
- Create: `packages/app/src/orchestrate/lifecycle.test.ts`

**Interfaces:**
- Consumes: `EvidenceGap` from `@control-tower/contracts`; `db` from `../db/client.js`; `incidents` from `../db/schema.js`.
- Produces:
  - `const RESOLVE_AFTER_QUIET_WINDOWS = 3`
  - `type ActiveIncident = { incidentId: string; detectedAt: string; dimensions: Record<string, string | undefined> }`
  - `type Transitions = { resolve: string[]; inconclusive: string[] }`
  - `function planTransitions(input: { bucket: string; active: ActiveIncident[]; evidenceGaps: EvidenceGap[] }): Transitions`
  - `type Lifecycle = { reconcile(input: { bucket: string; evidenceGaps: EvidenceGap[] }): Promise<Transitions> }`
  - `function createLifecycle(database?: Database): Lifecycle`

**Design notes the implementer must not deviate from:**

The decision logic is a **pure function** (`planTransitions`) so it can be tested exhaustively with no database. `reconcile` is the thin database wrapper: one SELECT of active incidents, then at most two set-based UPDATEs keyed by `incidentId IN (...)`. `rules.md` §6.8 forbids one query per cell.

Quiet windows are derived, not stored: `openOrUpdate` writes `detected_at = windowBucket` on every reconfirmation, so `bucket − detected_at` in minutes *is* the number of consecutive windows the cell has been silent. This is why no migration and no in-memory counter is needed, and why the count survives a process restart.

The `3` matches `PERSISTENCE_WINDOWS = 3` in `detect/constants.ts` — confirmation and resolution are deliberately symmetric. Do not import that constant: it belongs to the detector's trigger logic and the coupling would be accidental, not real.

A gap wins over a resolve. If the cell is in `evidenceGaps` its volume dropped below `MIN_VOLUME`, so the system cannot *assert* recovery — it says `inconclusive` instead, which is `spec.md` §5's first scored bonus (admitting the evidence is not enough rather than inventing a diagnosis).

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/orchestrate/lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EvidenceGap } from "@control-tower/contracts";
import { planTransitions, type ActiveIncident } from "./lifecycle";

const BUCKET = "2026-08-30T14:10:00.000Z";
const CELL = {
  merchantId: "BR_STORE_01",
  providerId: "adyen",
  country: "BR",
  paymentMethod: "CARD",
  issuerId: "itau",
};

function active(incidentId: string, detectedAt: string, dimensions = CELL): ActiveIncident {
  return { incidentId, detectedAt, dimensions };
}

function gap(dimensions: Record<string, string | undefined>): EvidenceGap {
  return {
    dimensions: dimensions as EvidenceGap["dimensions"],
    windowBucket: BUCKET,
    attempts: 4,
    reason: "INSUFFICIENT_EVIDENCE",
  };
}

describe("lifecycle transitions", () => {
  it("leaves an incident reconfirmed in this bucket alone", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", BUCKET)],
      evidenceGaps: [],
    });
    expect(result).toEqual({ resolve: [], inconclusive: [] });
  });

  it("does not resolve after a single quiet window", () => {
    // One quiet minute is noise, not recovery. Resolving here would close the
    // incident and reopen it next tick as a brand-new one, which is the
    // flapping the state machine exists to prevent.
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:09:00.000Z")],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual([]);
  });

  it("does not resolve after two quiet windows", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:08:00.000Z")],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual([]);
  });

  it("resolves after three quiet windows", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual(["a"]);
    expect(result.inconclusive).toEqual([]);
  });

  it("marks a quiet incident inconclusive when its cell lost volume", () => {
    // The cell went below MIN_VOLUME. The system cannot assert recovery, so it
    // admits the evidence is insufficient (spec.md §5) instead of resolving.
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [gap(CELL)],
    });
    expect(result.resolve).toEqual([]);
    expect(result.inconclusive).toEqual(["a"]);
  });

  it("does not confuse a gap on a different cell with this incident", () => {
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [gap({ ...CELL, providerId: "stripe" })],
    });
    expect(result.resolve).toEqual(["a"]);
    expect(result.inconclusive).toEqual([]);
  });

  it("treats a gap on a broader cell as a different cell", () => {
    // The incident is pinned to five dimensions; the gap fixes three. They are
    // not the same cell, so the gap must not silence this incident.
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z")],
      evidenceGaps: [gap({ merchantId: "BR_STORE_01", providerId: "adyen", country: "BR" })],
    });
    expect(result.inconclusive).toEqual([]);
  });

  it("separates two simultaneous incidents on different cells", () => {
    // spec.md §4 criterion 5: two incidents at once stay two incidents.
    const other = { ...CELL, merchantId: "MX_STORE_01", country: "MX", issuerId: "banorte" };
    const result = planTransitions({
      bucket: BUCKET,
      active: [active("a", "2026-08-30T14:07:00.000Z"), active("b", BUCKET, other)],
      evidenceGaps: [],
    });
    expect(result.resolve).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source ~/.nvm/nvm.sh && nvm use 22
cd /Users/diogoferreira/hackathon/yuno-control-tower
pnpm --filter @control-tower/app exec vitest run src/orchestrate/lifecycle.test.ts
```

Expected: FAIL — `Failed to resolve import "./lifecycle"`.

- [ ] **Step 3: Implement the lifecycle**

Create `packages/app/src/orchestrate/lifecycle.ts`:

```ts
import { and, inArray } from "drizzle-orm";
import type { EvidenceGap } from "@control-tower/contracts";
import { db as defaultDatabase } from "../db/client.js";
import { incidents } from "../db/schema.js";

type Database = typeof defaultDatabase;

// Symmetric to the detector's PERSISTENCE_WINDOWS = 3: it takes three windows
// to confirm a drop, so it takes three quiet windows to call it recovered.
// Deliberately not imported from detect/constants.ts — that constant belongs to
// the trigger, and coupling the two would be accidental rather than real.
export const RESOLVE_AFTER_QUIET_WINDOWS = 3;

const ACTIVE_STATUSES = ["open", "monitoring"] as const;

export type ActiveIncident = {
  incidentId: string;
  detectedAt: string;
  dimensions: Record<string, string | undefined>;
};

export type Transitions = {
  resolve: string[];
  inconclusive: string[];
};

export type Lifecycle = {
  reconcile(input: { bucket: string; evidenceGaps: EvidenceGap[] }): Promise<Transitions>;
};

function sameCell(
  left: Record<string, string | undefined>,
  right: Record<string, string | undefined>,
): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return keys.every((key) => left[key] === right[key]);
}

function quietWindows(bucket: string, detectedAt: string): number {
  return Math.round((new Date(bucket).getTime() - new Date(detectedAt).getTime()) / 60_000);
}

export function planTransitions(input: {
  bucket: string;
  active: ActiveIncident[];
  evidenceGaps: EvidenceGap[];
}): Transitions {
  const resolve: string[] = [];
  const inconclusive: string[] = [];

  for (const incident of input.active) {
    if (quietWindows(input.bucket, incident.detectedAt) < RESOLVE_AFTER_QUIET_WINDOWS) {
      continue;
    }
    const lostVolume = input.evidenceGaps.some((gap) =>
      sameCell(incident.dimensions, gap.dimensions as Record<string, string | undefined>),
    );
    // A gap outranks a resolve: without volume the system cannot claim the cell
    // recovered, so it says so instead of guessing (spec.md §5).
    if (lostVolume) {
      inconclusive.push(incident.incidentId);
    } else {
      resolve.push(incident.incidentId);
    }
  }

  return { resolve, inconclusive };
}

export function createLifecycle(database: Database = defaultDatabase): Lifecycle {
  return {
    async reconcile(input) {
      // One SELECT, then at most two set-based UPDATEs. rules.md §6.8 forbids
      // walking cells with one query each.
      const rows = await database
        .select({
          incidentId: incidents.incidentId,
          detectedAt: incidents.detectedAt,
          dimensions: incidents.dimensions,
        })
        .from(incidents)
        .where(inArray(incidents.status, [...ACTIVE_STATUSES]));

      const transitions = planTransitions({
        bucket: input.bucket,
        active: rows.map((row) => ({
          incidentId: row.incidentId,
          detectedAt: row.detectedAt.toISOString(),
          dimensions: row.dimensions as Record<string, string | undefined>,
        })),
        evidenceGaps: input.evidenceGaps,
      });

      if (transitions.resolve.length > 0) {
        await database
          .update(incidents)
          .set({ status: "resolved", resolvedAt: new Date(input.bucket) })
          .where(
            and(
              inArray(incidents.incidentId, transitions.resolve),
              inArray(incidents.status, [...ACTIVE_STATUSES]),
            ),
          );
      }

      if (transitions.inconclusive.length > 0) {
        await database
          .update(incidents)
          .set({ status: "inconclusive" })
          .where(
            and(
              inArray(incidents.incidentId, transitions.inconclusive),
              inArray(incidents.status, [...ACTIVE_STATUSES]),
            ),
          );
      }

      return transitions;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @control-tower/app exec vitest run src/orchestrate/lifecycle.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/orchestrate/lifecycle.ts packages/app/src/orchestrate/lifecycle.test.ts
git commit -m "feat(orchestrate): incident lifecycle state machine"
```

---

### Task 3: Fingerprint memory

**Files:**
- Create: `packages/app/src/orchestrate/memory.ts`
- Create: `packages/app/src/orchestrate/memory.integration.test.ts`

**Interfaces:**
- Consumes: `SimilarIncident` type from `@control-tower/contracts`; `db` from `../db/client.js`; `incidents` from `../db/schema.js`.
- Produces: `function createIncidentMemory(database?: Database): { recallByFingerprint(input: { fingerprint: string; excludeIncidentId?: string; limit?: number }): Promise<SimilarIncident[]> }`

**Design notes the implementer must not deviate from:**

DD15 locked exact fingerprint as the only recognition path; pgvector is deferred and there is no HNSW index in this delivery. This is a single indexed lookup against `ix_incident_fingerprint`, nothing more.

`SimilarIncident.rootCauseDimension` is not a column on `incidents` and not a field of `EvidenceObject`. It is derived from `playbook_id`, using a local constant map. It is deliberately **not** imported from `agent/playbooks.ts`: `roadmap.md` §7 lists the agentic layer as cut #4, and the spec requires that cutting `agent/` leaves `orchestrate/` working. Four stable entries are cheaper than that coupling.

`summary` is built deterministically from columns. It must never be model-generated — it feeds the investigator's prompt, and model text re-entering as evidence would launder invention into fact.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/orchestrate/memory.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/client";
import { incidents } from "../db/schema";
import { createIncidentMemory } from "./memory";

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
    startedAt: new Date("1970-01-01T00:07:00.000Z"),
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
      detectedAt: "1970-01-01T00:10:00.000Z",
      playbookId: "provider-default",
    });
    // Still live: not history yet, must not be recalled.
    await seedIncident({
      fingerprint,
      status: "monitoring",
      detectedAt: "1970-01-01T00:20:00.000Z",
      playbookId: "provider-default",
    });
    // A different cell entirely.
    await seedIncident({
      fingerprint: `test-${randomUUID()}`,
      status: "resolved",
      detectedAt: "1970-01-01T00:12:00.000Z",
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
      detectedAt: "1970-01-01T00:30:00.000Z",
      playbookId: "provider-default",
    });
    await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "1970-01-01T00:20:00.000Z",
      playbookId: "provider-default",
    });
    await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "1970-01-01T00:10:00.000Z",
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
    expect(recalled[0]?.summary).toContain("1970-01-01T00:20");
  });

  it("returns a null root cause when no playbook matched", async () => {
    const fingerprint = `test-${randomUUID()}`;
    await seedIncident({
      fingerprint,
      status: "resolved",
      detectedAt: "1970-01-01T00:10:00.000Z",
      playbookId: null,
    });

    const memory = createIncidentMemory();
    const recalled = await memory.recallByFingerprint({ fingerprint });

    // The contract allows null. Guessing a dimension here would be invention.
    expect(recalled[0]?.rootCauseDimension).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source ~/.nvm/nvm.sh && nvm use 22
cd /Users/diogoferreira/hackathon/yuno-control-tower
pnpm --filter @control-tower/app exec vitest run src/orchestrate/memory.integration.test.ts
```

Expected: FAIL — `Failed to resolve import "./memory"`.

- [ ] **Step 3: Implement the memory**

Create `packages/app/src/orchestrate/memory.ts`:

```ts
import { and, desc, eq, ne } from "drizzle-orm";
import { SimilarIncident, type RootCauseDimension } from "@control-tower/contracts";
import { db as defaultDatabase } from "../db/client.js";
import { incidents } from "../db/schema.js";

type Database = typeof defaultDatabase;

const DEFAULT_LIMIT = 3;

// Mirrors the four playbook YAML files, deliberately duplicated rather than
// imported from agent/playbooks.ts: roadmap.md §7 lists the agentic layer as
// cut #4, and orchestrate/ has to keep working after that cut.
const PLAYBOOK_ROOT_CAUSE: Record<string, RootCauseDimension> = {
  "provider-default": "provider",
  "issuer-default": "issuer",
  "method-country-default": "payment_method",
  "merchant-default": "merchant",
};

export type IncidentMemory = {
  recallByFingerprint(input: {
    fingerprint: string;
    excludeIncidentId?: string;
    limit?: number;
  }): Promise<SimilarIncident[]>;
};

export function createIncidentMemory(database: Database = defaultDatabase): IncidentMemory {
  return {
    async recallByFingerprint(input) {
      const filters = [
        eq(incidents.fingerprint, input.fingerprint),
        eq(incidents.status, "resolved"),
      ];
      if (input.excludeIncidentId) {
        filters.push(ne(incidents.incidentId, input.excludeIncidentId));
      }

      // Single indexed lookup on ix_incident_fingerprint. DD15: exact
      // fingerprint is the only recognition path; pgvector is deferred.
      const rows = await database
        .select({
          incidentId: incidents.incidentId,
          fingerprint: incidents.fingerprint,
          dominantDecline: incidents.dominantDecline,
          playbookId: incidents.playbookId,
          startedAt: incidents.startedAt,
          resolvedAt: incidents.resolvedAt,
          costUsdMinor: incidents.costUsdMinor,
        })
        .from(incidents)
        .where(and(...filters))
        .orderBy(desc(incidents.detectedAt))
        .limit(input.limit ?? DEFAULT_LIMIT);

      return rows.map((row) =>
        SimilarIncident.parse({
          incidentId: row.incidentId,
          fingerprint: row.fingerprint,
          rootCauseDimension: row.playbookId ? PLAYBOOK_ROOT_CAUSE[row.playbookId] ?? null : null,
          dominantDecline: row.dominantDecline,
          // Built from columns only. This string reaches the investigator's
          // prompt, and model-written text re-entering as evidence would
          // launder invention into fact.
          summary:
            `Same cell was down from ${row.startedAt.toISOString()} ` +
            `until ${row.resolvedAt?.toISOString() ?? "unknown"}, ` +
            `dominant decline ${row.dominantDecline ?? "none"}, ` +
            `cost ${row.costUsdMinor} USD minor units.`,
        }),
      );
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @control-tower/app exec vitest run src/orchestrate/memory.integration.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Create the barrel and commit**

Create `packages/app/src/orchestrate/index.ts`:

```ts
export { createIncidentWriter, type IncidentUpsert, type IncidentWriter } from "./incidents.js";
export {
  createLifecycle,
  planTransitions,
  RESOLVE_AFTER_QUIET_WINDOWS,
  type ActiveIncident,
  type Lifecycle,
  type Transitions,
} from "./lifecycle.js";
export { createIncidentMemory, type IncidentMemory } from "./memory.js";
```

```bash
git add packages/app/src/orchestrate/
git commit -m "feat(orchestrate): exact-fingerprint incident memory"
```

---

### Task 4: Move incident writes out of the agent and wire the tick

**Files:**
- Modify: `packages/app/src/agent/persistence.ts` — remove `upsertIncidentFromEvidence` from the `InvestigationRunRepository` interface (around line 74) and from both implementations (the in-memory one around line 238 and the Postgres one at 449-503).
- Modify: `packages/app/src/agent/coordinator.ts`
- Modify: `packages/app/src/agent/coordinator.test.ts`
- Modify: `packages/app/src/api/server.test.ts:161` and `:236` — both seed incidents through `repository.upsertIncidentFromEvidence`, which stops existing in this task
- Modify: `packages/app/src/run.ts`

**Interfaces:**
- Consumes: `createIncidentWriter`, `createLifecycle` from `../orchestrate/index.js` (Tasks 1 and 2).
- Produces: `handleSignal(input: { signal: ConfirmedDrop; incidentId: string; fingerprint: string }): Promise<void>` — the coordinator no longer creates incidents.

**Why `handleSignal` takes an object, and why it needs all three fields:** a
`ConfirmedDrop` carries neither a fingerprint nor an incident id (check
`packages/contracts/src/detection.ts:25-41` — the fields are not there, and this
plan does not add them). The evidence object has the fingerprint, the writer
returns the incident id, and the signal is what the investigator needs as its
trigger. Passing them positionally invites an argument-order bug; one object
does not.

**The signal-to-evidence join, stated precisely:** `EvidenceObject.dimensions`
is `diagnosis.cell` — the *causal* cell the beam search selected — while
`signal.dimensions` is `diagnosis.root`, the merchant×country cell that
triggered (DD17). They are not equal, and `buildEvidence` does not carry `root`
into the evidence object, so they cannot be joined by equality. They join by
**containment**: the causal cell always fixes every dimension the root fixes,
plus up to three more (DD19). So a signal matches an evidence when every
dimension the signal fixes has the same value in the evidence.

One signal can match **several** evidence objects — that is peeling working as
designed, and it is exactly `spec.md` §4 criterion 5, two simultaneous incidents
under one root. Each match is its own incident with its own id, so each gets its
own investigation.

**What changes and why:** this is the extraction that closes review finding I6. `rules.md` §6.3 assigns writes to `incidents` to `orchestrate/`, but `agent/persistence.ts` has been doing them. After this task `agent/` owns `investigation_runs` and `investigation_steps` only.

The second half is the reordering. Today an incident row is born only after the investigator and narrator finish — roughly thirty seconds of LLM after the tick already confirmed the drop, which is why the `incidents` table is empty. After this task the row is written at tick time from deterministic evidence, and the agent enriches it later.

- [ ] **Step 1: Remove `upsertIncidentFromEvidence` from the repository**

In `packages/app/src/agent/persistence.ts`:
- Delete the `upsertIncidentFromEvidence` declaration from the `InvestigationRunRepository` interface.
- Delete the method from the Postgres implementation (lines 449-503).
- In the in-memory implementation, replace the method with the `seedIncident(record: IncidentRecord): void` test-double helper described in Step 3b. Do not put `seedIncident` on the `InvestigationRunRepository` interface — production code must not be able to reach it.
- Remove `EvidenceObject` from the imports if nothing else in the file uses it.
- Leave `linkRunToIncident` and `listIncidents` in place — reads and the run/incident link stay with the agent's audit concern.

- [ ] **Step 2: Change the coordinator to enrich instead of create**

In `packages/app/src/agent/coordinator.ts`:

Add to the imports:

```ts
import type { IncidentWriter } from "../orchestrate/incidents.js";
```

Change `CoordinatorDeps` to carry the writer and drop the incident-creation duty:

```ts
type CoordinatorDeps = DeterministicInvestigationDataSourceDeps & {
  repository: InvestigationRunRepository;
  incidentWriter: IncidentWriter;
  config: AgentConfig;
  onEvidence?: (evidence: EvidenceObject) => void;
  onNarrative?: (payload: { incidentId: string; narrative: NarrativeOutput }) => void;
};
```

Replace the body of `persistOutcome` so it takes the incident id from the caller and attaches narrative to it:

```ts
  async function persistOutcome(
    request: InvestigationRequestV1,
    incidentId: string,
    diagnosis: Diagnosis,
    runIds: string[],
  ) {
    const evidence = buildEvidence({
      diagnosis,
      rows: await deps.source.getHistory(
        shift(request.trigger.windowBucket, -120),
        shift(request.trigger.windowBucket, 1),
      ),
      diagnosisSource: runIds.length > 1 ? "beam_search" : "agent",
    });
    const recommendation = matchRecommendation(diagnosis);
    const narrative = await renderNarratives(deps.config, { evidence, recommendation });

    // The row already exists: orchestrate/incidents.ts wrote it at tick time
    // from deterministic evidence. The agent only enriches it (rules.md §3).
    await deps.incidentWriter.attachNarrative({
      incidentId,
      narrativeOps: narrative.operations,
      narrativeExec: narrative.executive,
      playbookId: recommendation?.playbookId ?? null,
    });

    for (const runId of runIds) {
      await deps.repository.linkRunToIncident(runId, incidentId);
    }

    deps.onEvidence?.(evidence);
    deps.onNarrative?.({ incidentId, narrative });

    return { incidentId, evidence, narrative };
  }
```

Thread `incidentId` through `executeFallback`, `handleSignal` and `recoverOrphanRuns`:

```ts
  async function executeFallback(
    request: InvestigationRequestV1,
    incidentId: string,
    previousRunIds: string[],
  ) {
```

and inside it, replace the `persistOutcome(request, diagnosis, ...)` call with
`await persistOutcome(request, incidentId, diagnosis, previousRunIds.concat(runId));`

`handleSignal` takes an object and dedups on the incident, not on the signal:

```ts
    async handleSignal(input: {
      signal: ConfirmedDrop;
      incidentId: string;
      fingerprint: string;
    }): Promise<void> {
      const { signal, incidentId } = input;
      if (investigated.has(incidentId)) return;
      investigated.add(incidentId);
```

with the three inner call sites updated to pass `incidentId`:
`executeFallback(request, incidentId, [request.runId])` (twice) and
`persistOutcome(request, incidentId, materialized, [request.runId])`.

**Delete the `signalKey` function and its `investigated` key.** The dedup key
becomes `incidentId`. This is not cosmetic: `openOrUpdate` returns a stable id
for as long as the incident is live and a fresh one after it resolves, which is
precisely "investigate each live incident once". The old `signalKey` keyed on
`dimensions@startedAt` of the *root*, so when peeling finds two simultaneous
incidents under one root, the second would have been silently dropped —
`spec.md` §4 criterion 5 is the case that breaks.

`recoverOrphanRuns` needs the incident id of the orphan run. `RunRecord` already
carries `incidentId: string | null`. Skip orphans that never reached an
incident — there is nothing to enrich:

```ts
    async recoverOrphanRuns(): Promise<void> {
      const orphanRuns = await deps.repository.listOrphanRuns();
      for (const orphan of orphanRuns) {
        await deps.repository.failRun({
          runId: orphan.runId,
          completedAt: new Date().toISOString(),
          status: "failed",
          failureCode: "MODEL_ERROR",
        });
        // A run that never linked to an incident has nothing to enrich: the
        // tick that produced it will re-open the incident on its own.
        if (!orphan.incidentId) continue;
        await executeFallback(orphan.requestSnapshot, orphan.incidentId, [orphan.runId]);
      }
    }
```

- [ ] **Step 3: Update the coordinator tests for the new signature**

`packages/app/src/agent/coordinator.test.ts` builds its dependencies through a
`deps(overrides)` helper that returns `{ evidence, repository, built }`, and
calls `handleSignal` in nine places (lines 64, 80, 93, 94, 95, 105, 106, 125 and
134). Two changes:

**a.** Give `deps()` a default incident writer. Add these lines inside the
`built` object, before the `...overrides` spread so any test can replace them:

```ts
      incidentWriter: {
        async openOrUpdate() {
          return { incidentId: INCIDENT_ID, status: "open" as const };
        },
        async attachNarrative(input: { incidentId: string; playbookId: string | null }) {
          attached.push(input);
        },
      },
```

and, alongside `const evidence: EvidenceObject[] = [];` at the top of the
helper, add the capture array and the shared id, returning `attached` too:

```ts
const INCIDENT_ID = "11111111-2222-3333-4444-555555555555";
// inside deps():
  const attached: Array<{ incidentId: string; playbookId: string | null }> = [];
  // ...
  return { evidence, attached, repository, built: { ... } };
```

**b.** Update all nine `handleSignal` call sites to the object form:

```ts
await coordinator.handleSignal({
  signal: confirmedDrop(BR_ROOT),
  incidentId: INCIDENT_ID,
  fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#91",
});
```

Two of these tests deserve attention rather than mechanical editing. The one at
line 93-95 calls `handleSignal` three times with the same signal to prove the
investigation is not restarted on every tick — it must keep passing, because the
dedup key changed from `signalKey` to `incidentId` and the stub returns a
constant id, so the behaviour is preserved. The one at line 106 passes a
*different* signal; give it a different `incidentId` so it still exercises a
second investigation.

Where a test asserted an incident was created through the repository, assert
against `attached` instead — the coordinator's job is now enrichment.

- [ ] **Step 3b: Repoint the API tests at the new writer**

`packages/app/src/api/server.test.ts` seeds incidents through
`repository.upsertIncidentFromEvidence` at lines 161 and 236, so the API's
`listIncidents` route has something to return. That method is gone.

Important: this file uses `InMemoryInvestigationRunRepository` (line 38), **not
the real database**. Do not reach for `createIncidentWriter(db)` here — it would
turn a fast unit test into a write against the shared production-shape database.

`listIncidents` stays on the repository (this task moves *writes* out of
`agent/`, not reads). The in-memory double just needs a way to be seeded. In
`packages/app/src/agent/persistence.ts`, where you delete
`upsertIncidentFromEvidence` from `InMemoryInvestigationRunRepository`, add a
seeding method in its place — the in-memory class is a test double, and this is
the only thing the API tests need from it:

```ts
  // Test-double seeding. The real incident writer lives in
  // orchestrate/incidents.ts; this exists so API route tests can populate
  // listIncidents without touching a database.
  seedIncident(record: IncidentRecord): void {
    this.incidents.set(record.incidentId, record);
  }
```

(match `this.incidents` to whatever the existing in-memory field is actually
called — read the class before adding this.)

Then in `server.test.ts`, replace both calls. At line 161:

```ts
    const incidentId = randomUUID();
    repository.seedIncident({
      incidentId,
      fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#05",
      status: "open",
      detectedAt: "2026-08-30T14:06:00.000Z",
      startedAt: "2026-08-30T14:03:00.000Z",
      narrativeOps: "ops",
      narrativeExec: "exec",
      playbookId: "provider-default",
    });
```

and identically at line 236, where the id was already bound to `incidentId`.
Those eight fields are exactly `IncidentRecord` (`persistence.ts:35-44`), and
`"ops"` / `"exec"` / `"provider-default"` are the values both call sites already
passed (lines 188-190 and 263-265) — keep them, or the route assertions below
will fail for the wrong reason. Import `randomUUID` from `node:crypto` if the
file does not already.

The large inline `evidence` object each call passed can be deleted: `listIncidents`
returns `IncidentRecord`, which never carried it.

- [ ] **Step 4: Wire the tick in `run.ts`**

In `packages/app/src/run.ts`, add `orchestrate` to the dynamic import block:

```ts
  orchestrate,
] = await Promise.all([
  ...
  import("./orchestrate/index.js"),
]);
```

(keep the destructuring positions aligned — `orchestrate` goes last in both the
array pattern and the `Promise.all` list).

After `const hub = createSseHub();` add:

```ts
const incidentWriter = orchestrate.createIncidentWriter();
const lifecycle = orchestrate.createLifecycle();
```

Pass the writer to the coordinator:

```ts
const coordinator = agent.createAgentCoordinator({
  ...
  repository,
  incidentWriter,
  config: agent.loadAgentConfig(),
```

Replace the scheduler's `onResult` with an async body that writes incidents
first, reconciles second, broadcasts third, and only then hands off to the agent:

```ts
  onResult: ({ bucket, signals, evidenceGaps, evidence }) => {
    store.addSignals(signals);
    store.addGaps(evidenceGaps);
    evidenceStore.add(evidence);

    void (async () => {
      // Order matters: openOrUpdate bumps detected_at for every cell still
      // down, so a cell reconfirmed in THIS bucket is never resolved by the
      // reconcile pass that follows it.
      const opened = new Map<string, string>();
      for (const item of evidence) {
        const upserted = await incidentWriter.openOrUpdate(item);
        opened.set(item.fingerprint, upserted.incidentId);
      }

      const transitions = await lifecycle.reconcile({ bucket, evidenceGaps });
      if (transitions.resolve.length > 0 || transitions.inconclusive.length > 0) {
        hub.broadcast("incident-transitions", { bucket, ...transitions });
        logger.info({ bucket, ...transitions }, "incident lifecycle reconciled");
      }

      for (const item of evidence) hub.broadcast("evidence", item);
      for (const signal of signals) hub.broadcast("signal", signal);
      for (const gap of evidenceGaps) hub.broadcast("evidence-gap", gap);

      for (const item of evidence) {
        const incidentId = opened.get(item.fingerprint);
        if (!incidentId) continue;
        // The causal cell always fixes every dimension the root fixes, plus up
        // to three more (DD19), so the trigger is the signal the evidence
        // refines. Peeling can put two evidence objects under one signal —
        // that is criterion 5, and each gets its own investigation.
        const trigger = signals.find((signal) => refines(item.dimensions, signal.dimensions));
        if (!trigger) continue;
        void coordinator
          .handleSignal({ signal: trigger, incidentId, fingerprint: item.fingerprint })
          .catch((error: unknown) => {
            logger.error({ error, bucket, incidentId }, "agent coordinator failed");
          });
      }

      if (signals.length > 0 || evidenceGaps.length > 0) {
        logger.info(
          { bucket, signals: signals.length, evidenceGaps: evidenceGaps.length, evidence: evidence.length },
          "detection tick produced output",
        );
      }
    })().catch((error: unknown) => {
      // A failed write must not kill the tick: openOrUpdate is idempotent by
      // fingerprint and reconcile derives everything from detected_at, so the
      // next bucket recovers on its own.
      logger.error({ error, bucket }, "orchestration failed for this tick");
    });
  },
```

Add the `refines` helper near the top of `run.ts`, after the imports:

```ts
// A causal cell refines the root that triggered it: it fixes every dimension
// the root fixes, and may fix more (DD17 root is merchant×country, DD19 caps
// depth at 3). `buildEvidence` keeps only `diagnosis.cell`, so containment is
// how an EvidenceObject finds the ConfirmedDrop it came from.
function refines(
  cell: Record<string, string | undefined>,
  root: Record<string, string | undefined>,
): boolean {
  return Object.entries(root)
    .filter(([, value]) => value !== undefined)
    .every(([key, value]) => cell[key] === value);
}
```

- [ ] **Step 5: Run the full app suite and typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 22
cd /Users/diogoferreira/hackathon/yuno-control-tower
pnpm --filter @control-tower/app typecheck
pnpm --filter @control-tower/app test
```

Expected: typecheck clean, all tests pass. If `agent.e2e.test.ts` runs and takes
~30s, that is normal — it calls a real model.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/agent/ packages/app/src/run.ts
git commit -m "refactor(orchestrate): move incident writes out of agent, wire lifecycle into the tick"
```

---

### Task 5: Feed recalled incidents to the investigator

**Files:**
- Modify: `packages/app/src/agent/coordinator.ts` — `buildRequest` and `CoordinatorDeps`
- Modify: `packages/app/src/agent/coordinator.test.ts`
- Modify: `packages/app/src/run.ts`

**Interfaces:**
- Consumes: `createIncidentMemory` from `../orchestrate/index.js` (Task 3); `handleSignal(signal, incidentId)` from Task 4.
- Produces: nothing new — this fills the `similarIncidents` field that is already in the frozen contract and already interpolated by `agent/investigator.ts:51`.

- [ ] **Step 1: Write the failing test**

Add to `packages/app/src/agent/coordinator.test.ts`. This uses the helpers the
file already defines — `deps(overrides)`, which returns `{ evidence, repository,
built }`, and `confirmedDrop(BR_ROOT)` from `../diagnose/fixtures.js`:

```ts
const INCIDENT_ID = "11111111-2222-3333-4444-555555555555";

it("passes recalled incidents to the investigator", async () => {
  const recalled = [
    {
      incidentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#91",
      rootCauseDimension: "provider" as const,
      dominantDecline: "91",
      summary: "Same cell was down from 1970-01-01T00:07:00.000Z until 1970-01-01T00:47:00.000Z.",
    },
  ];
  const { built, repository } = deps({
    memory: {
      async recallByFingerprint() {
        return recalled;
      },
    },
  });

  await createAgentCoordinator(built).handleSignal({
    signal: confirmedDrop(BR_ROOT),
    incidentId: INCIDENT_ID,
    fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#91",
  });

  // Every run for this incident carries the request snapshot the investigator
  // was given, so the history reached the prompt rather than being dropped.
  const runs = await repository.listRunsByIncident(INCIDENT_ID);
  expect(runs.length).toBeGreaterThan(0);
  expect(runs[0]?.requestSnapshot.context.similarIncidents).toEqual(recalled);
});

it("investigates anyway when the memory lookup fails", async () => {
  // Memory is never on the critical path: a repeat incident is a bonus
  // (spec.md §5), not a precondition for diagnosing the live one.
  const { built, evidence } = deps({
    memory: {
      async recallByFingerprint() {
        throw new Error("memory unavailable");
      },
    },
  });

  await createAgentCoordinator(built).handleSignal({
    signal: confirmedDrop(BR_ROOT),
    incidentId: INCIDENT_ID,
    fingerprint: "country=BR|merchantId=BR_STORE_01|providerId=adyen#91",
  });

  expect(evidence).toHaveLength(1);
});
```

Add a default `memory` to the `deps()` helper's `built` object so the existing
tests keep compiling, placed before `...overrides` so a test can replace it:

```ts
      memory: { async recallByFingerprint() { return []; } },
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @control-tower/app exec vitest run src/agent/coordinator.test.ts
```

Expected: FAIL — `similarIncidents` is `[]`.

- [ ] **Step 3: Wire memory into `buildRequest`**

In `packages/app/src/agent/coordinator.ts`, add to `CoordinatorDeps`:

```ts
  memory: IncidentMemory;
```

with the import:

```ts
import type { IncidentMemory } from "../orchestrate/memory.js";
```

`buildRequest` becomes async and takes the recalled incidents:

```ts
function buildRequest(
  signal: ConfirmedDrop,
  similarIncidents: SimilarIncident[],
): InvestigationRequestV1 {
  if (!signal.dimensions.merchantId || !signal.dimensions.country) {
    throw new Error("ConfirmedDrop must include merchantId and country for orchestration");
  }
  return {
    schemaVersion: "1",
    runId: randomUUID(),
    source: "detector_orchestrator",
    trigger: signal,
    context: {
      merchantId: signal.dimensions.merchantId,
      detectedAt: signal.windowBucket,
      rootDimensions: {
        merchantId: signal.dimensions.merchantId,
        country: signal.dimensions.country,
      },
      similarIncidents,
    },
  };
}
```

Import `SimilarIncident` as a type from `@control-tower/contracts`.

In `handleSignal`, recall before building the request, using the `fingerprint`
that Task 4 already added to the input object (it comes from the
`EvidenceObject`, because `ConfirmedDrop` has no such field). A memory failure
must never block an investigation:

```ts
      const similarIncidents = await deps.memory
        .recallByFingerprint({ fingerprint: input.fingerprint, excludeIncidentId: incidentId })
        .catch(() => []);
      const request = buildRequest(signal, similarIncidents);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @control-tower/app exec vitest run src/agent/coordinator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire it in `run.ts`**

Add `const incidentMemory = orchestrate.createIncidentMemory();` beside the
writer and lifecycle, and pass `memory: incidentMemory` into
`createAgentCoordinator`.

- [ ] **Step 6: Run everything**

```bash
source ~/.nvm/nvm.sh && nvm use 22
cd /Users/diogoferreira/hackathon/yuno-control-tower
pnpm --filter @control-tower/app typecheck
pnpm --filter @control-tower/app test
pnpm --filter @control-tower/contracts test
pnpm --filter @control-tower/generator test
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/
git commit -m "feat(orchestrate): recall repeat incidents by fingerprint into the investigation"
```

---

### Task 6: Live verification and flight log

**Files:**
- Create: `flight_logs/incident_lifecycle_by_tick_silence.md`
- Modify: `flight_logs/README.md`

**Why a flight log is mandatory here:** `AGENTS.md` requires one for any decision
that "fixa um contrato de dados público, uma fronteira arquitetural" or
"descarta uma alternativa que um juiz provavelmente levantaria na sabatina".
This plan does both: it moves a write boundary between modules, and it chooses
silence-with-hysteresis over a positive recovery test — exactly the kind of
thing a judge asks about.

- [ ] **Step 1: Verify the pipeline live**

Start the app, inject an incident with the generator's injection API, watch an
incident open, then stop the injection and watch it resolve after three quiet
minutes.

```bash
source ~/.nvm/nvm.sh && nvm use 22
cd /Users/diogoferreira/hackathon/yuno-control-tower
pnpm --filter @control-tower/app dev
```

In a second shell, confirm rows appear and change status:

```bash
cd /Users/diogoferreira/hackathon/yuno-control-tower/packages/app && node -e '
import("dotenv").then(async (d)=>{ d.config({path:"../../.env"});
const {default:postgres}=await import("postgres");
const sql=postgres(process.env.DATABASE_URL,{ssl:"require"});
console.log(await sql`select status, count(*)::int c, max(detected_at) last from incidents group by status`);
await sql.end();});'
```

Expected progression: `open` appears within one tick of the injection,
becomes `monitoring` on the next tick, and becomes `resolved` roughly three
minutes after the injection stops.

**Record the actual observed output.** If incidents never appear, the wiring in
Task 4 Step 4 is wrong — do not write the flight log against an unverified
claim.

- [ ] **Step 2: Write the flight log**

Create `flight_logs/incident_lifecycle_by_tick_silence.md`. Portuguese, **no YAML
front matter** (flight logs are the documented exception in `AGENTS.md`), exactly
four sections in this order: title, options considered, what we chose, why — and
the "why" states what the choice costs, not only what it buys.

Cover: silence-with-hysteresis versus a positive recovery test versus immediate
silence; the three-window symmetry with `PERSISTENCE_WINDOWS`; `detected_at` as
a derived counter instead of a new column; and the cost — the system infers
recovery rather than proving it, and an incident whose cell stops being
evaluated at all resolves on a timer rather than on evidence.

- [ ] **Step 3: Add the index line**

Append the corresponding line to `flight_logs/README.md`, matching the format of
the entries already there.

- [ ] **Step 4: Commit**

```bash
git add flight_logs/
git commit -m "docs: flight log for incident lifecycle by tick silence"
```

---

## Notes for the executor

- The `incidents` table was empty (0 rows) when this plan was written. If Task 6
  still shows 0 rows after a live injection, the bug is in the `run.ts` wiring,
  not in Tasks 1-3 — those have their own passing tests.
- `packages/web` is being built in parallel by a teammate. Do not touch it. The
  only new thing the UI gains from this work is a real `incidentId` and a
  `status` that changes; the SSE event names above (`incident-transitions`) are
  additive and break nothing that exists.
