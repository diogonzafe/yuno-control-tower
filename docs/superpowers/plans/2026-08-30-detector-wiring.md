# Detector Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the finished-but-mute detection engine to the real database and an HTTP/SSE API, so a confirmed conversion drop reaches a client within ~3 minutes of happening.

**Architecture:** `db/queries.ts` implements the existing `RollupSource` interface with typed Drizzle selects. `detect/scheduler.ts` runs a 60s timer that computes which minute-bucket just closed, loads that bucket plus 120 minutes of history, calls the pure `runDetectionTick`, and hands the result to a sink. `api/` holds an in-memory ring buffer, an SSE hub, and Fastify routes. A single `run.ts` boots ingest + scheduler + API in one process.

**Tech Stack:** TypeScript strict/ESM, Node 22, Fastify 5, Drizzle (postgres-js), Zod, pino, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-detector-wiring-design.md` — read it alongside this plan.

## Global Constraints

- Code, identifiers, file names, and error messages: English only (`rules.md` §2).
- `DATABASE_URL` / `REDIS_URL` come from the repo-root `.env`. Never print their values.
- **The database holds ~90,000 rows of real retroactive data (2026-08-28 → 2026-08-29) that must never be deleted.** Integration tests use `1970-01-01` buckets (the pattern already adopted in this repo) and delete only rows they created, scoped by the full primary key.
- Use **typed Drizzle selects**, never `db.execute` raw SQL. Raw SQL stays reserved for `diagnose/`'s dynamic `GROUP BY` cube queries (`rules.md` §6.3.1). This also avoids the BIGINT-as-string hazard of §6.8.
- `merchants.expectedConversion` and `merchants.minMaterialDropPp` are `numeric` **without** an explicit mode, so Drizzle returns **string**. They MUST be converted with `Number()`. Without this the Wilson test compares a number against a string and the detector silently never fires.
- `rollup_minute.bucket` is a `timestamp` (Drizzle returns `Date`), but `RollupRow.bucket` is an ISO `string`. Convert at the SQL boundary.
- `rollup_minute.country` is `char(2)`; `RollupRow.country` is the union `"BR" | "MX" | "AR"`. Cast at the SQL boundary.
- Scheduler constants: grace `10_000` ms, catch-up cap `10` buckets, tick interval `60_000` ms, ring buffer cap `200`, SSE heartbeat `20_000` ms.
- Reuse `aggregateByBucket` from `detect/aggregate.ts` for `/api/conversion` — do not write a second aggregation (`rules.md` §1).
- Do not write to the `incidents` table. That belongs to `orchestrate/`, which does not exist yet.

---

### Task 1: RollupSource implementation and catalog loaders

**Files:**
- Modify: `packages/app/src/db/queries.ts`
- Create: `packages/app/src/db/queries.integration.test.ts`

**Interfaces:**
- Consumes: `db` from `./client.js`; `rollupMinute`, `merchants`, `routingCoverage` from `./schema.js`; `RollupRow`, `MerchantConfig`, `RoutingCoverage` from `../detect/types.js`.
- Produces, all exported from `packages/app/src/db/queries.ts`:
  - `createRollupSource(): RollupSource` — implements the existing interface.
  - `loadMerchantConfigs(): Promise<MerchantConfig[]>`
  - `loadRoutingCoverage(): Promise<RoutingCoverage>`
  Tasks 3, 5 and 6 depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/db/queries.integration.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "./client.js";
import { rollupMinute } from "./schema.js";
import { createRollupSource, loadMerchantConfigs, loadRoutingCoverage } from "./queries.js";

// 1970 keeps this test impossibly far from both the ~90k rows of real
// retroactive data and anything the live generator writes today.
const BUCKET = new Date("1970-01-01T00:00:00.000Z");
const CELL = {
  bucket: BUCKET,
  merchantId: "BR_STORE_01",
  providerId: "adyen",
  country: "BR",
  paymentMethod: "CARD",
  issuerId: "itau",
};

afterEach(async () => {
  await db.delete(rollupMinute).where(
    and(
      eq(rollupMinute.bucket, CELL.bucket),
      eq(rollupMinute.merchantId, CELL.merchantId),
      eq(rollupMinute.providerId, CELL.providerId),
      eq(rollupMinute.country, CELL.country),
      eq(rollupMinute.paymentMethod, CELL.paymentMethod),
      eq(rollupMinute.issuerId, CELL.issuerId),
    ),
  );
});

describe("createRollupSource", () => {
  it("returns the seeded cell as a RollupRow with an ISO bucket and numeric sums", async () => {
    await db.insert(rollupMinute).values({
      ...CELL,
      attempts: 40,
      approved: 10,
      amountMinorSum: 4000,
      amountUsdSum: 800,
      approvedUsdSum: 200,
    });

    const rows = await createRollupSource().getWindowRollups("1970-01-01T00:00:00.000Z");
    const row = rows.find((candidate) => candidate.merchantId === "BR_STORE_01");

    expect(row).toBeDefined();
    expect(row!.bucket).toBe("1970-01-01T00:00:00.000Z");
    expect(row!.attempts).toBe(40);
    expect(row!.approved).toBe(10);
    expect(typeof row!.amountUsdSum).toBe("number");
    expect(row!.amountUsdSum).toBe(800);
    expect(row!.country).toBe("BR");
  });

  it("getHistory returns rows in [from, to) and excludes the upper bound", async () => {
    await db.insert(rollupMinute).values({
      ...CELL,
      attempts: 5,
      approved: 5,
      amountMinorSum: 0,
      amountUsdSum: 0,
      approvedUsdSum: 0,
    });

    const included = await createRollupSource().getHistory(
      "1969-12-31T23:00:00.000Z",
      "1970-01-01T00:01:00.000Z",
    );
    const excluded = await createRollupSource().getHistory(
      "1969-12-31T23:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
    );

    expect(included.some((row) => row.merchantId === "BR_STORE_01")).toBe(true);
    expect(excluded.some((row) => row.merchantId === "BR_STORE_01")).toBe(false);
  });
});

describe("catalog loaders", () => {
  it("loads merchant configs with numeric conversions, never strings", async () => {
    const configs = await loadMerchantConfigs();

    expect(configs.length).toBe(9);
    for (const config of configs) {
      // The whole point: numeric columns arrive as strings from Drizzle, and a
      // string here makes the Wilson comparison silently never fire.
      expect(typeof config.expectedConversion).toBe("number");
      expect(typeof config.minMaterialDropPp).toBe("number");
      expect(config.expectedConversion).toBeGreaterThan(0);
      expect(config.expectedConversion).toBeLessThanOrEqual(1);
    }
  });

  it("loads the 12 DD13 routing coverage rows", async () => {
    const coverage = await loadRoutingCoverage();

    expect(coverage).toHaveLength(12);
    expect(coverage.some((route) => route.paymentMethod === "PIX" && route.country === "BR")).toBe(true);
    expect(coverage.some((route) => route.paymentMethod === "PIX" && route.country !== "BR")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test queries.integration`
Expected: FAIL — `createRollupSource is not exported from './queries.js'`.

- [ ] **Step 3: Implement the queries**

Replace the contents of `packages/app/src/db/queries.ts` (keep the existing `RollupSource` interface exactly as it is, add the implementation below it):

```ts
import { and, gte, lt, eq } from "drizzle-orm";
import { db } from "./client.js";
import { merchants, rollupMinute, routingCoverage } from "./schema.js";
import type { MerchantConfig, RollupRow, RoutingCoverage } from "../detect/types.js";

// SQL implementation belongs to the DB-layer branch; the detector receives arrays.
export interface RollupSource {
  getWindowRollups(bucket: string): Promise<RollupRow[]>;
  getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]>;
}

type RollupSelect = typeof rollupMinute.$inferSelect;

// bucket is a TIMESTAMPTZ (Drizzle hands back a Date) while RollupRow.bucket is
// an ISO string, and country is char(2) while RollupRow.country is a union —
// both are narrowed here, once, at the SQL boundary, so the pure engine keeps
// receiving exactly the shape its fixtures already use.
function toRollupRow(row: RollupSelect): RollupRow {
  return {
    bucket: row.bucket.toISOString(),
    merchantId: row.merchantId,
    providerId: row.providerId,
    country: row.country as RollupRow["country"],
    paymentMethod: row.paymentMethod as RollupRow["paymentMethod"],
    issuerId: row.issuerId,
    attempts: row.attempts,
    approved: row.approved,
    amountUsdSum: row.amountUsdSum,
    approvedUsdSum: row.approvedUsdSum,
  };
}

export function createRollupSource(): RollupSource {
  return {
    async getWindowRollups(bucket) {
      const rows = await db.select().from(rollupMinute).where(eq(rollupMinute.bucket, new Date(bucket)));
      return rows.map(toRollupRow);
    },
    async getHistory(fromBucket, toBucket) {
      const rows = await db
        .select()
        .from(rollupMinute)
        .where(and(gte(rollupMinute.bucket, new Date(fromBucket)), lt(rollupMinute.bucket, new Date(toBucket))));
      return rows.map(toRollupRow);
    },
  };
}

export async function loadMerchantConfigs(): Promise<MerchantConfig[]> {
  const rows = await db
    .select({
      merchantId: merchants.merchantId,
      expectedConversion: merchants.expectedConversion,
      minMaterialDropPp: merchants.minMaterialDropPp,
    })
    .from(merchants);

  // numeric() without an explicit mode is Drizzle's string mode. Passing those
  // strings into the Wilson comparison would silently never fire.
  return rows.map((row) => ({
    merchantId: row.merchantId,
    expectedConversion: Number(row.expectedConversion),
    minMaterialDropPp: Number(row.minMaterialDropPp),
  }));
}

export async function loadRoutingCoverage(): Promise<RoutingCoverage> {
  return db
    .select({
      providerId: routingCoverage.providerId,
      country: routingCoverage.country,
      paymentMethod: routingCoverage.paymentMethod,
    })
    .from(routingCoverage);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @control-tower/app test queries.integration`
Expected: PASS, 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/db/queries.ts packages/app/src/db/queries.integration.test.ts
git commit -m "feat(db): implement RollupSource and catalog loaders"
```

---

### Task 2: Signal store (in-memory ring buffer)

**Files:**
- Create: `packages/app/src/api/signal-store.ts`
- Create: `packages/app/src/api/signal-store.test.ts`

**Interfaces:**
- Consumes: `ConfirmedDrop`, `EvidenceGap` from `@control-tower/contracts`.
- Produces, exported from `packages/app/src/api/signal-store.ts`:
  - `type SignalStore = { addSignals(signals: ConfirmedDrop[]): void; addGaps(gaps: EvidenceGap[]): void; recentSignals(limit?: number): ConfirmedDrop[]; recentGaps(limit?: number): EvidenceGap[] }`
  - `createSignalStore(cap?: number): SignalStore` — default cap 200.
  Tasks 5 and 6 depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/api/signal-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import { createSignalStore } from "./signal-store.js";

function signal(bucketMinute: number): ConfirmedDrop {
  const bucket = `2026-08-30T14:${String(bucketMinute).padStart(2, "0")}:00.000Z`;
  return {
    dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
    windowBucket: bucket, observedRate: 0.41, expectedRate: 0.95,
    expectedSource: "cross_sectional", deltaPp: 3, ciLow: 0.36, ciHigh: 0.46,
    ciLevel: 0.95, attempts: 420, approved: 172, windowUsed: "1m",
    startedAt: bucket, startedAtExact: true, consecutiveWindows: 3,
  };
}

function gap(attempts: number): EvidenceGap {
  return {
    dimensions: { merchantId: "MX_STORE_01", country: "MX" },
    windowBucket: "2026-08-30T14:06:00.000Z", attempts, reason: "INSUFFICIENT_EVIDENCE",
  };
}

describe("createSignalStore", () => {
  it("returns nothing when empty", () => {
    const store = createSignalStore();
    expect(store.recentSignals()).toEqual([]);
    expect(store.recentGaps()).toEqual([]);
  });

  it("returns the newest signal first", () => {
    const store = createSignalStore();
    store.addSignals([signal(1)]);
    store.addSignals([signal(2)]);

    expect(store.recentSignals().map((s) => s.windowBucket)).toEqual([
      "2026-08-30T14:02:00.000Z",
      "2026-08-30T14:01:00.000Z",
    ]);
  });

  it("keeps newest-first ordering within a single batch", () => {
    const store = createSignalStore();
    store.addSignals([signal(1), signal(2)]);

    expect(store.recentSignals()[0]!.windowBucket).toBe("2026-08-30T14:02:00.000Z");
  });

  it("drops the oldest entries past the cap", () => {
    const store = createSignalStore(3);
    store.addSignals([signal(1), signal(2), signal(3), signal(4)]);

    const buckets = store.recentSignals().map((s) => s.windowBucket);
    expect(buckets).toHaveLength(3);
    expect(buckets).not.toContain("2026-08-30T14:01:00.000Z");
  });

  it("honours the limit argument", () => {
    const store = createSignalStore();
    store.addSignals([signal(1), signal(2), signal(3)]);

    expect(store.recentSignals(2)).toHaveLength(2);
  });

  it("keeps signals and gaps in separate buffers", () => {
    const store = createSignalStore();
    store.addSignals([signal(1)]);
    store.addGaps([gap(7), gap(8)]);

    expect(store.recentSignals()).toHaveLength(1);
    expect(store.recentGaps()).toHaveLength(2);
    expect(store.recentGaps()[0]!.attempts).toBe(8);
  });

  it("ignores empty batches", () => {
    const store = createSignalStore();
    store.addSignals([]);
    store.addGaps([]);

    expect(store.recentSignals()).toEqual([]);
    expect(store.recentGaps()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test signal-store`
Expected: FAIL — `Cannot find module './signal-store.js'`.

- [ ] **Step 3: Implement the store**

Create `packages/app/src/api/signal-store.ts`:

```ts
import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";

export type SignalStore = {
  addSignals(signals: ConfirmedDrop[]): void;
  addGaps(gaps: EvidenceGap[]): void;
  recentSignals(limit?: number): ConfirmedDrop[];
  recentGaps(limit?: number): EvidenceGap[];
};

const DEFAULT_CAP = 200;

// Signals live only in this process: writing them to `incidents` is
// orchestrate/'s job, and that module does not exist yet.
export function createSignalStore(cap = DEFAULT_CAP): SignalStore {
  const signals: ConfirmedDrop[] = [];
  const gaps: EvidenceGap[] = [];

  function push<T>(buffer: T[], items: T[]): void {
    for (const item of items) {
      buffer.unshift(item);
    }
    buffer.length = Math.min(buffer.length, cap);
  }

  return {
    addSignals(incoming) {
      push(signals, incoming);
    },
    addGaps(incoming) {
      push(gaps, incoming);
    },
    recentSignals(limit = cap) {
      return signals.slice(0, limit);
    },
    recentGaps(limit = cap) {
      return gaps.slice(0, limit);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @control-tower/app test signal-store`
Expected: PASS, 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/api/signal-store.ts packages/app/src/api/signal-store.test.ts
git commit -m "feat(api): add in-memory signal store"
```

---

### Task 3: Scheduler

**Files:**
- Create: `packages/app/src/detect/scheduler.ts`
- Create: `packages/app/src/detect/scheduler.test.ts`

**Interfaces:**
- Consumes: `runDetectionTick` from `./tick.js`; `PersistenceState` from `./persistence.js`; `RollupRow`, `MerchantConfig`, `RoutingCoverage` from `./types.js`; `ONSET_LOOKBACK_MIN` from `./constants.js`; `RollupSource` from `../db/queries.js`; `ConfirmedDrop`, `EvidenceGap` from `@control-tower/contracts`.
- Produces, exported from `packages/app/src/detect/scheduler.ts`:
  - `targetBucket(now: Date): string` — pure.
  - `bucketsToProcess(lastProcessed: string | null, target: string, cap?: number): string[]` — pure.
  - `type SchedulerDeps = { source: RollupSource; loadMerchants: () => Promise<MerchantConfig[]>; loadCoverage: () => Promise<RoutingCoverage>; onResult: (result: { bucket: string; signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[] }) => void; now?: () => Date }`
  - `type SchedulerStatus = { lastTickAt: string | null; lastProcessedBucket: string | null; bucketLagMinutes: number | null; lastError: string | null }`
  - `type SchedulerHandle = { runOnce(): Promise<void>; getStatus(): SchedulerStatus; stop(): void }`
  - `createScheduler(deps: SchedulerDeps): SchedulerHandle` — does NOT start a timer.
  - `startScheduler(deps: SchedulerDeps, intervalMs?: number): SchedulerHandle` — wraps `createScheduler` in a `setInterval`.
  Tasks 5 and 6 depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/scheduler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import type { RollupSource } from "../db/queries.js";
import type { RollupRow } from "./types.js";
import { bucketsToProcess, createScheduler, targetBucket } from "./scheduler.js";

describe("targetBucket", () => {
  it("returns the minute that closed most recently, after the ingest grace window", () => {
    // 14:07:10 with a 10s grace -> 14:07 has just become safe to read, so the
    // last fully closed bucket is 14:06.
    expect(targetBucket(new Date("2026-08-30T14:07:10.000Z"))).toBe("2026-08-30T14:06:00.000Z");
  });

  it("still points at the previous bucket inside the grace window", () => {
    // 14:07:05 is within the grace, so 14:07 is not trusted yet: stay on 14:05.
    expect(targetBucket(new Date("2026-08-30T14:07:05.000Z"))).toBe("2026-08-30T14:05:00.000Z");
  });
});

describe("bucketsToProcess", () => {
  it("processes only the latest bucket on a cold start", () => {
    expect(bucketsToProcess(null, "2026-08-30T14:06:00.000Z")).toEqual(["2026-08-30T14:06:00.000Z"]);
  });

  it("returns nothing when the target was already processed", () => {
    expect(bucketsToProcess("2026-08-30T14:06:00.000Z", "2026-08-30T14:06:00.000Z")).toEqual([]);
  });

  it("returns nothing when the target is older than the cursor", () => {
    expect(bucketsToProcess("2026-08-30T14:06:00.000Z", "2026-08-30T14:05:00.000Z")).toEqual([]);
  });

  it("catches up over skipped buckets, in order", () => {
    expect(bucketsToProcess("2026-08-30T14:03:00.000Z", "2026-08-30T14:06:00.000Z")).toEqual([
      "2026-08-30T14:04:00.000Z",
      "2026-08-30T14:05:00.000Z",
      "2026-08-30T14:06:00.000Z",
    ]);
  });

  it("caps catch-up and keeps the most recent buckets", () => {
    const buckets = bucketsToProcess("2026-08-30T10:00:00.000Z", "2026-08-30T14:06:00.000Z", 3);

    expect(buckets).toEqual([
      "2026-08-30T14:04:00.000Z",
      "2026-08-30T14:05:00.000Z",
      "2026-08-30T14:06:00.000Z",
    ]);
  });
});

function healthyRows(bucket: string): RollupRow[] {
  return [{
    bucket, merchantId: "BR_STORE_01", providerId: "adyen", country: "BR",
    paymentMethod: "CARD", issuerId: "itau", attempts: 100, approved: 95,
    amountUsdSum: 1000, approvedUsdSum: 950,
  }];
}

function deps(overrides: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  const results: Array<{ bucket: string; signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[] }> = [];
  const source: RollupSource = {
    getWindowRollups: async (bucket) => healthyRows(bucket),
    getHistory: async () => [],
  };
  const base = {
    source,
    loadMerchants: async () => [{ merchantId: "BR_STORE_01", expectedConversion: 0.95, minMaterialDropPp: 3 }],
    loadCoverage: async () => [{ providerId: "adyen", country: "BR", paymentMethod: "CARD" }],
    onResult: (result: { bucket: string; signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[] }) => { results.push(result); },
    now: () => new Date("2026-08-30T14:07:10.000Z"),
    ...overrides,
  };
  return { deps: base, results };
}

describe("createScheduler", () => {
  it("processes the closed bucket and reports it in the status", async () => {
    const { deps: d, results } = deps();
    const scheduler = createScheduler(d);

    await scheduler.runOnce();

    expect(results.map((r) => r.bucket)).toEqual(["2026-08-30T14:06:00.000Z"]);
    expect(scheduler.getStatus().lastProcessedBucket).toBe("2026-08-30T14:06:00.000Z");
    expect(scheduler.getStatus().lastError).toBeNull();
  });

  it("does not reprocess the same bucket on a second run", async () => {
    const { deps: d, results } = deps();
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    await scheduler.runOnce();

    expect(results).toHaveLength(1);
  });

  it("records the error and does not advance the cursor when a tick fails", async () => {
    const { deps: d, results } = deps({
      source: {
        getWindowRollups: async () => { throw new Error("connection lost"); },
        getHistory: async () => [],
      },
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();

    expect(results).toEqual([]);
    expect(scheduler.getStatus().lastProcessedBucket).toBeNull();
    expect(scheduler.getStatus().lastError).toContain("connection lost");
  });

  it("retries the failed bucket on the next run once the source recovers", async () => {
    let shouldFail = true;
    const { deps: d, results } = deps({
      source: {
        getWindowRollups: async (bucket) => {
          if (shouldFail) throw new Error("connection lost");
          return healthyRows(bucket);
        },
        getHistory: async () => [],
      },
    });
    const scheduler = createScheduler(d);

    await scheduler.runOnce();
    shouldFail = false;
    await scheduler.runOnce();

    expect(results.map((r) => r.bucket)).toEqual(["2026-08-30T14:06:00.000Z"]);
    expect(scheduler.getStatus().lastError).toBeNull();
  });

  it("reports the bucket lag in minutes", async () => {
    const { deps: d } = deps();
    const scheduler = createScheduler(d);

    await scheduler.runOnce();

    // Processed 14:06 while "now" is 14:07:10 — one whole minute behind.
    expect(scheduler.getStatus().bucketLagMinutes).toBe(1);
  });

  it("requests exactly the configured history window", async () => {
    const requested: Array<[string, string]> = [];
    const { deps: d } = deps({
      source: {
        getWindowRollups: async (bucket) => healthyRows(bucket),
        getHistory: async (from, to) => { requested.push([from, to]); return []; },
      },
    });

    await createScheduler(d).runOnce();

    // ONSET_LOOKBACK_MIN is 120: [bucket - 120min, bucket).
    expect(requested).toEqual([["2026-08-30T12:06:00.000Z", "2026-08-30T14:06:00.000Z"]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test scheduler`
Expected: FAIL — `Cannot find module './scheduler.js'`.

- [ ] **Step 3: Implement the scheduler**

Create `packages/app/src/detect/scheduler.ts`:

```ts
import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import pino from "pino";
import type { RollupSource } from "../db/queries.js";
import { ONSET_LOOKBACK_MIN } from "./constants.js";
import { runDetectionTick } from "./tick.js";
import type { PersistenceState } from "./persistence.js";
import type { MerchantConfig, RoutingCoverage } from "./types.js";

const logger = pino({ name: "detector-scheduler", level: process.env.VITEST ? "silent" : "info" });

const MINUTE_MS = 60_000;
// Gives the ingest consumer time to finish writing the minute that just
// closed. Costs 10s of detection latency, irrelevant against the 3 consecutive
// windows the persistence rule already requires.
const INGEST_GRACE_MS = 10_000;
const CATCH_UP_CAP = 10;
const TICK_INTERVAL_MS = 60_000;

export type SchedulerDeps = {
  source: RollupSource;
  loadMerchants: () => Promise<MerchantConfig[]>;
  loadCoverage: () => Promise<RoutingCoverage>;
  onResult: (result: { bucket: string; signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[] }) => void;
  now?: () => Date;
};

export type SchedulerStatus = {
  lastTickAt: string | null;
  lastProcessedBucket: string | null;
  bucketLagMinutes: number | null;
  lastError: string | null;
};

export type SchedulerHandle = {
  runOnce(): Promise<void>;
  getStatus(): SchedulerStatus;
  stop(): void;
};

function floorToMinute(date: Date): Date {
  const floored = new Date(date);
  floored.setUTCSeconds(0, 0);
  return floored;
}

function shift(bucket: string, minutes: number): string {
  return new Date(new Date(bucket).getTime() + minutes * MINUTE_MS).toISOString();
}

export function targetBucket(now: Date): string {
  return shift(floorToMinute(new Date(now.getTime() - INGEST_GRACE_MS)).toISOString(), -1);
}

export function bucketsToProcess(lastProcessed: string | null, target: string, cap = CATCH_UP_CAP): string[] {
  if (lastProcessed === null) return [target];
  if (new Date(target) <= new Date(lastProcessed)) return [];

  const buckets: string[] = [];
  for (let bucket = shift(lastProcessed, 1); new Date(bucket) <= new Date(target); bucket = shift(bucket, 1)) {
    buckets.push(bucket);
  }
  // Keeping the most recent buckets means a long outage loses the oldest
  // minutes rather than delaying detection of what is happening now.
  return buckets.slice(-cap);
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const now = deps.now ?? (() => new Date());
  let persistence: PersistenceState = new Map();
  let lastProcessedBucket: string | null = null;
  let lastTickAt: string | null = null;
  let lastError: string | null = null;

  return {
    async runOnce() {
      const at = now();
      lastTickAt = at.toISOString();
      const target = targetBucket(at);

      try {
        const [merchants, coverage] = await Promise.all([deps.loadMerchants(), deps.loadCoverage()]);

        for (const bucket of bucketsToProcess(lastProcessedBucket, target)) {
          const [windowRows, history] = await Promise.all([
            deps.source.getWindowRollups(bucket),
            deps.source.getHistory(shift(bucket, -ONSET_LOOKBACK_MIN), bucket),
          ]);

          const output = runDetectionTick({ bucket, windowRows, history, merchants, coverage, prevState: persistence });
          persistence = output.nextState;
          lastProcessedBucket = bucket;
          deps.onResult({ bucket, signals: output.signals, evidenceGaps: output.evidenceGaps });
        }

        lastError = null;
      } catch (error) {
        // The cursor deliberately stays put: the next tick's catch-up retries
        // this bucket. A persistent failure shows up as a growing
        // bucketLagMinutes on /health rather than as silently skipped minutes.
        lastError = error instanceof Error ? error.message : String(error);
        logger.error({ error, target }, "detection tick failed");
      }
    },
    getStatus() {
      return {
        lastTickAt,
        lastProcessedBucket,
        bucketLagMinutes:
          lastProcessedBucket === null
            ? null
            : Math.floor((floorToMinute(now()).getTime() - new Date(lastProcessedBucket).getTime()) / MINUTE_MS),
        lastError,
      };
    },
    stop() {},
  };
}

export function startScheduler(deps: SchedulerDeps, intervalMs = TICK_INTERVAL_MS): SchedulerHandle {
  const scheduler = createScheduler(deps);
  const timer = setInterval(() => {
    scheduler.runOnce().catch((error: unknown) => logger.error({ error }, "scheduler tick rejected unexpectedly"));
  }, intervalMs);

  return {
    runOnce: () => scheduler.runOnce(),
    getStatus: () => scheduler.getStatus(),
    stop: () => clearInterval(timer),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @control-tower/app test scheduler`
Expected: PASS, 12 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/scheduler.ts packages/app/src/detect/scheduler.test.ts
git commit -m "feat(detect): add scheduler with bounded catch-up"
```

---

### Task 4: SSE hub

**Files:**
- Create: `packages/app/src/api/sse.ts`
- Create: `packages/app/src/api/sse.test.ts`

**Interfaces:**
- Produces, exported from `packages/app/src/api/sse.ts`:
  - `type SseConnection = { write(chunk: string): boolean; on(event: "close", listener: () => void): void }` — the minimal surface of a Node `ServerResponse`, so tests need no socket.
  - `type SseHub = { register(connection: SseConnection): void; broadcast(event: string, data: unknown): void; connectionCount(): number; stop(): void }`
  - `createSseHub(heartbeatMs?: number): SseHub` — default 20000.
  Tasks 5 and 6 depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/api/sse.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseHub, type SseConnection } from "./sse.js";

function fakeConnection(options: { failOnWrite?: boolean } = {}) {
  const written: string[] = [];
  const closeListeners: Array<() => void> = [];
  const connection: SseConnection = {
    write(chunk) {
      if (options.failOnWrite) throw new Error("socket closed");
      written.push(chunk);
      return true;
    },
    on(_event, listener) { closeListeners.push(listener); },
  };
  return { connection, written, close: () => closeListeners.forEach((listener) => listener()) };
}

afterEach(() => { vi.useRealTimers(); });

describe("createSseHub", () => {
  it("writes the SSE wire format on broadcast", () => {
    const hub = createSseHub();
    const client = fakeConnection();
    hub.register(client.connection);

    hub.broadcast("signal", { windowBucket: "2026-08-30T14:06:00.000Z" });

    expect(client.written).toEqual([
      'event: signal\ndata: {"windowBucket":"2026-08-30T14:06:00.000Z"}\n\n',
    ]);
    hub.stop();
  });

  it("delivers to every registered connection", () => {
    const hub = createSseHub();
    const first = fakeConnection();
    const second = fakeConnection();
    hub.register(first.connection);
    hub.register(second.connection);

    hub.broadcast("evidence-gap", { attempts: 7 });

    expect(first.written).toHaveLength(1);
    expect(second.written).toHaveLength(1);
    expect(hub.connectionCount()).toBe(2);
    hub.stop();
  });

  it("drops a connection whose write throws, without failing the broadcast", () => {
    const hub = createSseHub();
    const healthy = fakeConnection();
    const broken = fakeConnection({ failOnWrite: true });
    hub.register(broken.connection);
    hub.register(healthy.connection);

    expect(() => hub.broadcast("signal", { ok: true })).not.toThrow();

    expect(healthy.written).toHaveLength(1);
    expect(hub.connectionCount()).toBe(1);
    hub.stop();
  });

  it("removes a connection when it closes", () => {
    const hub = createSseHub();
    const client = fakeConnection();
    hub.register(client.connection);

    client.close();

    expect(hub.connectionCount()).toBe(0);
    hub.stop();
  });

  it("sends a comment heartbeat so proxies keep the stream open", () => {
    vi.useFakeTimers();
    const hub = createSseHub(1000);
    const client = fakeConnection();
    hub.register(client.connection);

    vi.advanceTimersByTime(1000);

    expect(client.written).toEqual([": keepalive\n\n"]);
    hub.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test sse`
Expected: FAIL — `Cannot find module './sse.js'`.

- [ ] **Step 3: Implement the hub**

Create `packages/app/src/api/sse.ts`:

```ts
import pino from "pino";

const logger = pino({ name: "sse-hub", level: process.env.VITEST ? "silent" : "info" });

const DEFAULT_HEARTBEAT_MS = 20_000;

// The minimal slice of Node's ServerResponse this hub needs, so tests can
// exercise it without a socket.
export type SseConnection = {
  write(chunk: string): boolean;
  on(event: "close", listener: () => void): void;
};

export type SseHub = {
  register(connection: SseConnection): void;
  broadcast(event: string, data: unknown): void;
  connectionCount(): number;
  stop(): void;
};

export function createSseHub(heartbeatMs = DEFAULT_HEARTBEAT_MS): SseHub {
  const connections = new Set<SseConnection>();

  function send(connection: SseConnection, chunk: string): void {
    try {
      connection.write(chunk);
    } catch (error) {
      // A dead socket must not take down the broadcast for everyone else.
      connections.delete(connection);
      logger.error({ error }, "dropped an SSE connection that failed to write");
    }
  }

  const heartbeat = setInterval(() => {
    for (const connection of [...connections]) {
      send(connection, ": keepalive\n\n");
    }
  }, heartbeatMs);

  return {
    register(connection) {
      connections.add(connection);
      connection.on("close", () => connections.delete(connection));
    },
    broadcast(event, data) {
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const connection of [...connections]) {
        send(connection, chunk);
      }
    },
    connectionCount: () => connections.size,
    stop: () => clearInterval(heartbeat),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @control-tower/app test sse`
Expected: PASS, 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/api/sse.ts packages/app/src/api/sse.test.ts
git commit -m "feat(api): add SSE hub"
```

---

### Task 5: Fastify server and routes

**Files:**
- Modify: `packages/app/package.json` (add `fastify` and `zod` dependencies)
- Create: `packages/app/src/api/server.ts`
- Create: `packages/app/src/api/server.test.ts`

**Interfaces:**
- Consumes: `createSignalStore`/`SignalStore` (Task 2), `createSseHub`/`SseHub` (Task 4), `SchedulerHandle`/`SchedulerStatus` (Task 3), `RollupSource` (Task 1), `aggregateByBucket` from `../detect/aggregate.js`.
- Produces, exported from `packages/app/src/api/server.ts`:
  - `type ServerDeps = { store: SignalStore; hub: SseHub; source: RollupSource; getSchedulerStatus: () => SchedulerStatus; isIngestUp: () => boolean }`
  - `buildServer(deps: ServerDeps): FastifyInstance`
  Task 6 depends on these exact names.

- [ ] **Step 1: Add the dependencies**

Run: `pnpm --filter @control-tower/app add fastify@^5.2.0 zod@^3.24.1`

- [ ] **Step 2: Write the failing test**

Create `packages/app/src/api/server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ConfirmedDrop } from "@control-tower/contracts";
import type { RollupSource } from "../db/queries.js";
import type { RollupRow } from "../detect/types.js";
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
    amountUsdSum: attempts * 10, approvedUsdSum: approved * 10,
  };
}

function build(overrides: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const store = createSignalStore();
  const hub = createSseHub();
  const source: RollupSource = {
    getWindowRollups: async () => [],
    getHistory: async () => [
      historyRow("2026-08-30T14:05:00.000Z", 100, 95),
      historyRow("2026-08-30T14:06:00.000Z", 100, 40),
    ],
  };
  const app = buildServer({
    store, hub, source,
    getSchedulerStatus: () => ({
      lastTickAt: "2026-08-30T14:07:10.000Z",
      lastProcessedBucket: "2026-08-30T14:06:00.000Z",
      bucketLagMinutes: 1,
      lastError: null,
    }),
    isIngestUp: () => true,
    ...overrides,
  });
  return { app, store, hub };
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test server`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 4: Implement the server**

Create `packages/app/src/api/server.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { RollupSource } from "../db/queries.js";
import { aggregateByBucket } from "../detect/aggregate.js";
import type { SchedulerStatus } from "../detect/scheduler.js";
import type { SliceFilter } from "../detect/types.js";
import type { SignalStore } from "./signal-store.js";
import type { SseConnection, SseHub } from "./sse.js";

export type ServerDeps = {
  store: SignalStore;
  hub: SseHub;
  source: RollupSource;
  getSchedulerStatus: () => SchedulerStatus;
  isIngestUp: () => boolean;
};

const limitQuery = z.object({ limit: z.coerce.number().int().positive().optional() });

const conversionQuery = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  merchantId: z.string().optional(),
  providerId: z.string().optional(),
  country: z.enum(["BR", "MX", "AR"]).optional(),
  paymentMethod: z.enum(["CARD", "PIX"]).optional(),
  issuerId: z.string().optional(),
});

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    const status = deps.getSchedulerStatus();
    return {
      status: status.lastError === null ? "ok" : "degraded",
      ingest: deps.isIngestUp() ? "up" : "down",
      lastTickAt: status.lastTickAt,
      lastProcessedBucket: status.lastProcessedBucket,
      bucketLagMinutes: status.bucketLagMinutes,
      lastError: status.lastError,
      sseConnections: deps.hub.connectionCount(),
    };
  });

  app.get("/api/signals", async (request, reply) => {
    const query = limitQuery.safeParse(request.query);
    if (!query.success) {
      await reply.status(400).send({ error: "invalid query", issues: query.error.issues });
      return;
    }
    return deps.store.recentSignals(query.data.limit);
  });

  app.get("/api/evidence-gaps", async (request, reply) => {
    const query = limitQuery.safeParse(request.query);
    if (!query.success) {
      await reply.status(400).send({ error: "invalid query", issues: query.error.issues });
      return;
    }
    return deps.store.recentGaps(query.data.limit);
  });

  app.get("/api/conversion", async (request, reply) => {
    const query = conversionQuery.safeParse(request.query);
    if (!query.success) {
      await reply.status(400).send({ error: "invalid query", issues: query.error.issues });
      return;
    }

    const { from, to, ...dimensions } = query.data;
    const filter: SliceFilter = Object.fromEntries(
      Object.entries(dimensions).filter(([, value]) => value !== undefined),
    );
    const rows = await deps.source.getHistory(from, to);

    // Reuses the detector's own aggregation rather than adding a second
    // implementation of approved/attempts (rules.md §1, DRY).
    return aggregateByBucket(rows, { filter }).map((point) => ({
      bucket: point.bucket,
      attempts: point.attempts,
      approved: point.approved,
      rate: point.rate,
    }));
  });

  app.get("/api/stream", (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    deps.hub.register(reply.raw as unknown as SseConnection);
  });

  return app;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @control-tower/app test server`
Expected: PASS, 9 tests green.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/app/package.json packages/app/src/api/server.ts packages/app/src/api/server.test.ts pnpm-lock.yaml
git commit -m "feat(api): add Fastify server with REST and SSE routes"
```

---

### Task 6: Single-process entrypoint and end-to-end verification

**Files:**
- Create: `packages/app/src/run.ts`
- Delete: `packages/app/src/ingest/run.ts`
- Modify: `packages/app/package.json` (replace the `ingest:dev` script with `dev`)

**Interfaces:**
- Consumes: `startConsumer` from `./ingest/consumer.js`; `createRollupSource`, `loadMerchantConfigs`, `loadRoutingCoverage` from `./db/queries.js`; `startScheduler` from `./detect/scheduler.js`; `createSignalStore` from `./api/signal-store.js`; `createSseHub` from `./api/sse.js`; `buildServer` from `./api/server.js`.
- Produces: nothing consumed by later tasks — this is the runnable entrypoint.

- [ ] **Step 1: Write the entrypoint**

Create `packages/app/src/run.ts`:

```ts
import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env before importing anything that reaches db/client.ts: a static
// top-level import would be hoisted by ESM and evaluated before this config()
// call, and db/client.ts reads DATABASE_URL at module-load time. The dynamic
// imports below defer that evaluation until after the environment is loaded.
config({ path: resolve(import.meta.dirname, "../../../.env") });

const [{ default: pino }, { startConsumer }, queries, { startScheduler }, { createSignalStore }, { createSseHub }, { buildServer }] =
  await Promise.all([
    import("pino"),
    import("./ingest/consumer.js"),
    import("./db/queries.js"),
    import("./detect/scheduler.js"),
    import("./api/signal-store.js"),
    import("./api/sse.js"),
    import("./api/server.js"),
  ]);

const logger = pino({ name: "app" });
const port = Number(process.env.APP_PORT ?? 4000);

const store = createSignalStore();
const hub = createSseHub();
let ingestUp = true;

// rules.md §6.2: the app process consumes the stream, runs the detector, and
// serves REST/SSE — one process, so a confirmed drop reaches SSE through a
// function call instead of another Redis channel.
startConsumer().catch((error: unknown) => {
  ingestUp = false;
  logger.fatal({ error }, "ingest consumer crashed");
  process.exit(1);
});

const scheduler = startScheduler({
  source: queries.createRollupSource(),
  loadMerchants: queries.loadMerchantConfigs,
  loadCoverage: queries.loadRoutingCoverage,
  onResult: ({ bucket, signals, evidenceGaps }) => {
    store.addSignals(signals);
    store.addGaps(evidenceGaps);
    for (const signal of signals) hub.broadcast("signal", signal);
    for (const gap of evidenceGaps) hub.broadcast("evidence-gap", gap);
    if (signals.length > 0 || evidenceGaps.length > 0) {
      logger.info({ bucket, signals: signals.length, evidenceGaps: evidenceGaps.length }, "detection tick produced output");
    }
  },
});

const app = buildServer({
  store, hub,
  source: queries.createRollupSource(),
  getSchedulerStatus: scheduler.getStatus,
  isIngestUp: () => ingestUp,
});

await app.listen({ port, host: "0.0.0.0" });
logger.info({ port }, "app started: ingest + detector + API");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    hub.stop();
    app.close()
      .catch((error: unknown) => logger.error({ error }, "error while shutting down"))
      .finally(() => process.exit(0));
  });
}
```

- [ ] **Step 2: Delete the superseded ingest entrypoint**

```bash
git rm packages/app/src/ingest/run.ts
```

- [ ] **Step 3: Replace the dev script**

In `packages/app/package.json`, replace the `"ingest:dev"` script line with:

```json
"dev": "tsx watch src/run.ts"
```

Leave `test` and `typecheck` unchanged. This also brings the repo in line with
`rules.md` §6.7, which already documents the command as `pnpm --filter app dev`.

- [ ] **Step 3b: Document the new environment variable**

Append to `.env.example`, after the `packages/generator` block:

```bash

# packages/app
APP_PORT=4000
```

- [ ] **Step 4: Typecheck and run the whole suite**

Run:
```bash
pnpm --filter @control-tower/app typecheck
pnpm --filter @control-tower/app test
```
Expected: no type errors; every test green.

- [ ] **Step 5: Verify the process boots and serves**

Start it in the background from the repo root:
```bash
pnpm --filter @control-tower/app dev
```
Expected log line: `"app started: ingest + detector + API"` with `port: 4000`, plus `"ingest consumer started"`.

Then, in another terminal:
```bash
curl -s localhost:4000/health
```
Expected: JSON with `"status":"ok"`, `"ingest":"up"`, and `lastProcessedBucket` filling in within ~70 seconds of boot (the first tick).

```bash
curl -s "localhost:4000/api/conversion?from=$(date -u -v-10M +%Y-%m-%dT%H:%M:00.000Z)&to=$(date -u +%Y-%m-%dT%H:%M:00.000Z)"
```
Expected: an array of `{ bucket, attempts, approved, rate }` points, non-empty if the generator is running.

- [ ] **Step 6: Verify detection end to end**

This is the first time the whole system runs together. With the app process still up, start the generator in another terminal (it needs `GENERATOR_TRAFFIC_WEIGHTS` from `.env`):

```bash
pnpm --filter @control-tower/generator dev
```

Open the SSE stream in a third terminal:
```bash
curl -N localhost:4000/api/stream
```

Inject an incident through the generator's injection API, using real seeded ids and a start time of now:
```bash
curl -s -X POST localhost:4100/incidents -H 'content-type: application/json' -d "{
  \"id\": \"wiring-check\",
  \"startsAt\": \"$(date -u +%Y-%m-%dT%H:%M:00.000Z)\",
  \"dimensions\": { \"providerId\": \"adyen\", \"country\": \"BR\" },
  \"conversionMultiplier\": 0.3
}"
```

Expected: within roughly 3–5 minutes (3 consecutive windows of persistence plus the 10s grace), an `event: signal` arrives on the SSE stream with `dimensions` naming `adyen`, and `GET /api/signals` returns the same drop.

Then remove the injected incident and stop both processes:
```bash
curl -s -X DELETE localhost:4100/incidents/wiring-check
```

Clean up the transactions the verification produced, keeping the ~90k retroactive rows untouched — delete only rows newer than when you started:
```bash
psql "$DATABASE_URL" -c "delete from transactions where created_at > now() - interval '30 minutes';"
psql "$DATABASE_URL" -c "delete from rollup_minute where bucket > now() - interval '30 minutes';"
psql "$DATABASE_URL" -c "delete from rollup_declines_minute where bucket > now() - interval '30 minutes';"
psql "$DATABASE_URL" -c "select count(*) from transactions where created_at < '2026-08-30';"
```
The last query must still report 90000.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/run.ts packages/app/package.json .env.example
git commit -m "feat(app): single-process entrypoint for ingest, detector and API"
```
