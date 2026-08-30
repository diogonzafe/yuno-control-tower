# Ingestion Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume the transaction event Redis Stream that `packages/generator` writes and keep `transactions`, `rollup_minute` and `rollup_declines_minute` correct and idempotent under redelivery.

**Architecture:** A shared Zod contract (`packages/contracts`) validates every event. `packages/app/src/ingest/consumer.ts` owns everything Redis (consumer group, read loop, ack, crash recovery). `packages/app/src/ingest/rollup.ts` owns everything Postgres (bulk insert with `ON CONFLICT ... RETURNING` for idempotency, in-memory delta aggregation, bulk upserts), wrapped in one DB transaction per batch. `rollup.ts` never imports anything Redis-related.

**Tech Stack:** TypeScript strict/ESM, Node 22, pnpm workspaces, Zod, drizzle-orm (postgres-js driver), ioredis, pino, vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-ingestion-pipeline-design.md` — read it alongside this plan. The two flight logs it references (`flight_logs/contrato_do_evento_de_transacao.md`, `flight_logs/ingestao_em_micro_batch_com_dedup.md`) explain *why* the batching/idempotency approach was chosen; this plan only covers *how*.

## Global Constraints

- Code, identifiers, file names, and error messages: English only (`AGENTS.md`).
- The agent never sees raw transactions; the narrator never calculates — not touched by this plan, but don't create anything that violates those boundaries later (`AGENTS.md`).
- No retry / no `PENDING` state on the transaction model itself — 1 request = 1 attempt (DD1/DD2). Retries in this plan are only about *redelivery of the same event*, never about re-attempting a payment.
- `rollup_minute.latency_p50_ms` stays `NULL` in this work — explicitly out of scope (see spec, "Simplificação assumida").
- Consumer group name `ingest`, consumer name `app-1`, stream key `stream:transactions` — fixed, do not parameterize.
- All monetary/count columns that use `bigint({ mode: "number" })` in the Drizzle schema accept plain JS `number`. All `numeric(...)` columns without an explicit mode (e.g. `fxRate`) are Drizzle's default **string** mode — convert with `.toString()` before inserting, never pass a `number` there.
- `DATABASE_URL` and `REDIS_URL` come from the repo-root `.env`. Never print their values in logs or commit them anywhere.

---

### Task 1: Contracts package — `transactionEventSchema`

**Files:**
- Create: `tsconfig.base.json` (repo root)
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/vitest.config.ts`
- Modify: `packages/contracts/package.json`
- Create: `packages/contracts/src/transaction.ts`
- Create: `packages/contracts/src/transaction.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `transactionEventSchema` (Zod schema), `TransactionEvent` (TS type), and the const arrays `COUNTRIES`, `PAYMENT_METHODS`, `CURRENCIES`, `FX_SOURCES`, `TRANSACTION_STATUSES`, `CARD_TYPES` — all exported from `@control-tower/contracts`. Every later task that touches an event imports `TransactionEvent` from here.

- [ ] **Step 1: Add the root TypeScript base config**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

Save as `tsconfig.base.json` at the repo root.

- [ ] **Step 2: Add `packages/contracts/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Add vitest and a minimal config**

Run: `pnpm --filter @control-tower/contracts add -D vitest@^2.1.8`

Create `packages/contracts/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: Add `test` and `typecheck` scripts to `packages/contracts/package.json`**

The file currently reads:

```json
{
  "name": "@control-tower/contracts",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

Replace it with:

```json
{
  "name": "@control-tower/contracts",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

(Step 3's `pnpm add -D` already wrote the vitest version into the file — check it matches before moving on; adjust the literal above if pnpm resolved a different patch version.)

- [ ] **Step 5: Write the failing test**

Create `packages/contracts/src/transaction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { transactionEventSchema } from "./transaction";

function validCardEvent(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "9f0b8b0e-6b0a-4b8a-8b0a-6b0a4b8a8b0a",
    merchantOrderId: "order-1",
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 10000,
    fxRate: 5.2,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 1923,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: "tok_123",
    latencyMs: 120,
    createdAt: "2026-08-30T14:03:00.000Z",
    ...overrides,
  };
}

describe("transactionEventSchema", () => {
  it("accepts a valid CARD/SUCCESS event", () => {
    const result = transactionEventSchema.safeParse(validCardEvent());
    expect(result.success).toBe(true);
  });

  it("accepts a valid PIX event in BR", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({
        paymentMethod: "PIX",
        country: "BR",
        cardBrand: null,
        cardType: null,
        cardBin: null,
        issuerId: "NA",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects PIX outside BR", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ paymentMethod: "PIX", country: "MX" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects DECLINED without a declineCode", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ status: "DECLINED", declineCode: null }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects SUCCESS with a declineCode present", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ status: "SUCCESS", declineCode: "05" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts DECLINED with a declineCode", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ status: "DECLINED", declineCode: "05" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an unknown country", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ country: "US" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative amountMinor", () => {
    const result = transactionEventSchema.safeParse(
      validCardEvent({ amountMinor: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it("treats an omitted optional field the same as an explicit null", () => {
    const event = validCardEvent();
    delete (event as Record<string, unknown>).cardBrand;
    const result = transactionEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/contracts test`
Expected: FAIL — `Cannot find module './transaction'` (the file doesn't exist yet).

- [ ] **Step 7: Implement `transactionEventSchema`**

Create `packages/contracts/src/transaction.ts`:

```ts
import { z } from "zod";

export const COUNTRIES = ["AR", "MX", "BR"] as const;
export const PAYMENT_METHODS = ["CARD", "PIX"] as const;
export const CURRENCIES = ["ARS", "MXN", "BRL"] as const;
export const FX_SOURCES = ["PTAX", "DOF", "BCRA_A3500", "MOCK"] as const;
export const TRANSACTION_STATUSES = ["SUCCESS", "DECLINED"] as const;
export const CARD_TYPES = ["debit", "credit"] as const;

export const transactionEventSchema = z
  .object({
    transactionId: z.string().uuid(),
    merchantOrderId: z.string().min(1),
    merchantId: z.string().min(1),
    providerId: z.string().min(1),
    country: z.enum(COUNTRIES),
    paymentMethod: z.enum(PAYMENT_METHODS),
    currency: z.enum(CURRENCIES),
    amountMinor: z.number().int().nonnegative(),
    fxRate: z.number().positive(),
    fxRateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
    fxSource: z.enum(FX_SOURCES),
    amountUsdMinor: z.number().int().nonnegative(),
    status: z.enum(TRANSACTION_STATUSES),
    declineCode: z.string().min(1).nullable().optional(),
    rawDeclineCode: z.string().min(1).nullable().optional(),
    cardBrand: z.string().min(1).nullable().optional(),
    cardType: z.enum(CARD_TYPES).nullable().optional(),
    cardBin: z.string().length(6).nullable().optional(),
    issuerId: z.string().min(1),
    token: z.string().min(1).nullable().optional(),
    latencyMs: z.number().int().nonnegative().nullable().optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .refine(
    (event) => (event.status === "DECLINED") === (event.declineCode != null),
    {
      message: "declineCode must be present if and only if status is DECLINED",
      path: ["declineCode"],
    },
  )
  .refine(
    (event) => event.paymentMethod !== "PIX" || event.country === "BR",
    {
      message: "PIX is only valid when country is BR (DD5)",
      path: ["paymentMethod"],
    },
  );

export type TransactionEvent = z.infer<typeof transactionEventSchema>;
```

- [ ] **Step 8: Export it from the package entrypoint**

Replace `packages/contracts/src/index.ts` (currently `export {};`) with:

```ts
export * from "./transaction";
```

- [ ] **Step 9: Run the tests and verify they pass**

Run: `pnpm --filter @control-tower/contracts test`
Expected: PASS, all 9 tests green.

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @control-tower/contracts typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add tsconfig.base.json packages/contracts
git commit -m "feat(contracts): add transactionEventSchema"
```

---

### Task 2: `aggregateDeltas` — pure rollup aggregation

**Files:**
- Create: `packages/app/tsconfig.json`
- Modify: `packages/app/package.json`
- Create: `packages/app/vitest.config.ts`
- Create: `packages/app/src/ingest/rollup.ts`
- Create: `packages/app/src/ingest/rollup.test.ts`

**Interfaces:**
- Consumes: `TransactionEvent` from `@control-tower/contracts` (Task 1).
- Produces: `RollupMinuteDelta`, `RollupDeclineDelta`, `AggregatedDeltas` types and `aggregateDeltas(events: TransactionEvent[]): AggregatedDeltas`, all exported from `packages/app/src/ingest/rollup.ts`. Task 5 (upserts) and Task 6 (`processBatch`) both import from here.

- [ ] **Step 1: Add `packages/app/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Add the workspace dependency on contracts, plus vitest**

Run:
```bash
pnpm --filter @control-tower/app add @control-tower/contracts@workspace:*
pnpm --filter @control-tower/app add -D vitest@^2.1.8
```

- [ ] **Step 3: Add `test`/`typecheck` scripts to `packages/app/package.json`**

The file currently reads:

```json
{
  "name": "@control-tower/app",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "dependencies": {
    "drizzle-orm": "^0.36.4",
    "postgres": "^3.4.5"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

After steps 2 and 5 (this task) and step 2 of Task 3, it should look like this (merge in whatever pnpm actually resolved for the two new deps if the printed version differs):

```json
{
  "name": "@control-tower/app",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@control-tower/contracts": "workspace:*",
    "drizzle-orm": "^0.36.4",
    "postgres": "^3.4.5"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 4: Add a minimal vitest config**

Create `packages/app/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 5: Write the failing test**

Create `packages/app/src/ingest/rollup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TransactionEvent } from "@control-tower/contracts";
import { aggregateDeltas } from "./rollup";

function baseEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    transactionId: "00000000-0000-4000-8000-000000000001",
    merchantOrderId: "order-1",
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 1000,
    fxRate: 5,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 200,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: null,
    latencyMs: null,
    createdAt: "2026-08-30T14:03:10.000Z",
    ...overrides,
  };
}

describe("aggregateDeltas", () => {
  it("returns empty deltas for an empty batch", () => {
    const result = aggregateDeltas([]);
    expect(result.minuteDeltas).toEqual([]);
    expect(result.declineDeltas).toEqual([]);
  });

  it("floors createdAt to the minute and sums attempts/approved/amounts for one cell", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", createdAt: "2026-08-30T14:03:05.000Z", amountMinor: 1000, amountUsdMinor: 200, status: "SUCCESS" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", createdAt: "2026-08-30T14:03:55.000Z", amountMinor: 2000, amountUsdMinor: 400, status: "DECLINED", declineCode: "05" }),
    ];

    const { minuteDeltas } = aggregateDeltas(events);

    expect(minuteDeltas).toHaveLength(1);
    expect(minuteDeltas[0]).toMatchObject({
      bucket: new Date("2026-08-30T14:03:00.000Z"),
      merchantId: "merchant-1",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
      attempts: 2,
      approved: 1,
      amountMinorSum: 3000,
      amountUsdSum: 600,
      approvedUsdSum: 200,
    });
  });

  it("splits events into separate cells across different minutes", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", createdAt: "2026-08-30T14:03:59.000Z" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", createdAt: "2026-08-30T14:04:00.000Z" }),
    ];

    const { minuteDeltas } = aggregateDeltas(events);

    expect(minuteDeltas).toHaveLength(2);
    expect(minuteDeltas.map((d) => d.bucket.toISOString())).toEqual([
      "2026-08-30T14:03:00.000Z",
      "2026-08-30T14:04:00.000Z",
    ]);
  });

  it("splits events into separate cells across the 5 dimensions", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", providerId: "adyen" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", providerId: "stripe" }),
    ];

    const { minuteDeltas } = aggregateDeltas(events);

    expect(minuteDeltas).toHaveLength(2);
  });

  it("produces a decline delta only for DECLINED events, counted per decline_code", () => {
    const events = [
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000001", status: "SUCCESS" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000002", status: "DECLINED", declineCode: "05" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000003", status: "DECLINED", declineCode: "05" }),
      baseEvent({ transactionId: "00000000-0000-4000-8000-000000000004", status: "DECLINED", declineCode: "91" }),
    ];

    const { declineDeltas } = aggregateDeltas(events);

    expect(declineDeltas).toHaveLength(2);
    expect(declineDeltas.find((d) => d.declineCode === "05")).toMatchObject({ count: 2 });
    expect(declineDeltas.find((d) => d.declineCode === "91")).toMatchObject({ count: 1 });
  });

  it("throws if a DECLINED event has no declineCode (contract should have already rejected this upstream)", () => {
    const events = [
      baseEvent({ status: "DECLINED", declineCode: null }),
    ];

    expect(() => aggregateDeltas(events)).toThrow();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test`
Expected: FAIL — `Cannot find module './rollup'`.

- [ ] **Step 7: Implement `aggregateDeltas`**

Create `packages/app/src/ingest/rollup.ts`:

```ts
import type { TransactionEvent } from "@control-tower/contracts";

export type RollupMinuteDelta = {
  bucket: Date;
  merchantId: string;
  providerId: string;
  country: string;
  paymentMethod: string;
  issuerId: string;
  attempts: number;
  approved: number;
  amountMinorSum: number;
  amountUsdSum: number;
  approvedUsdSum: number;
};

export type RollupDeclineDelta = {
  bucket: Date;
  merchantId: string;
  providerId: string;
  country: string;
  paymentMethod: string;
  issuerId: string;
  declineCode: string;
  count: number;
};

export type AggregatedDeltas = {
  minuteDeltas: RollupMinuteDelta[];
  declineDeltas: RollupDeclineDelta[];
};

function floorToMinute(isoTimestamp: string): Date {
  const date = new Date(isoTimestamp);
  date.setUTCSeconds(0, 0);
  return date;
}

function cellKey(bucket: Date, event: TransactionEvent): string {
  return [
    bucket.toISOString(),
    event.merchantId,
    event.providerId,
    event.country,
    event.paymentMethod,
    event.issuerId,
  ].join("|");
}

export function aggregateDeltas(events: TransactionEvent[]): AggregatedDeltas {
  const minuteMap = new Map<string, RollupMinuteDelta>();
  const declineMap = new Map<string, RollupDeclineDelta>();

  for (const event of events) {
    const bucket = floorToMinute(event.createdAt);
    const key = cellKey(bucket, event);
    const isApproved = event.status === "SUCCESS";
    const existing = minuteMap.get(key);

    if (existing) {
      existing.attempts += 1;
      existing.approved += isApproved ? 1 : 0;
      existing.amountMinorSum += event.amountMinor;
      existing.amountUsdSum += event.amountUsdMinor;
      existing.approvedUsdSum += isApproved ? event.amountUsdMinor : 0;
    } else {
      minuteMap.set(key, {
        bucket,
        merchantId: event.merchantId,
        providerId: event.providerId,
        country: event.country,
        paymentMethod: event.paymentMethod,
        issuerId: event.issuerId,
        attempts: 1,
        approved: isApproved ? 1 : 0,
        amountMinorSum: event.amountMinor,
        amountUsdSum: event.amountUsdMinor,
        approvedUsdSum: isApproved ? event.amountUsdMinor : 0,
      });
    }

    if (event.status === "DECLINED") {
      const declineCode = event.declineCode;
      if (!declineCode) {
        // The contract's .refine() should make this unreachable in
        // production; guarded here because aggregateDeltas is a pure
        // function that must not silently swallow an invariant violation.
        throw new Error(
          `DECLINED event ${event.transactionId} has no declineCode`,
        );
      }

      const declineKey = `${key}|${declineCode}`;
      const existingDecline = declineMap.get(declineKey);
      if (existingDecline) {
        existingDecline.count += 1;
      } else {
        declineMap.set(declineKey, {
          bucket,
          merchantId: event.merchantId,
          providerId: event.providerId,
          country: event.country,
          paymentMethod: event.paymentMethod,
          issuerId: event.issuerId,
          declineCode,
          count: 1,
        });
      }
    }
  }

  return {
    minuteDeltas: [...minuteMap.values()],
    declineDeltas: [...declineMap.values()],
  };
}
```

- [ ] **Step 8: Run the tests and verify they pass**

Run: `pnpm --filter @control-tower/app test`
Expected: PASS, all 6 tests green.

- [ ] **Step 9: Commit**

```bash
git add packages/app
git commit -m "feat(ingest): add aggregateDeltas pure rollup aggregation"
```

---

### Task 3: Postgres client

**Files:**
- Create: `packages/app/src/db/client.ts`
- Create: `packages/app/src/db/client.test.ts`
- Create: `packages/app/vitest.setup.ts`
- Modify: `packages/app/vitest.config.ts`
- Modify: `packages/app/package.json`

**Interfaces:**
- Consumes: `packages/app/src/db/schema.ts` (already exists — exports `merchants`, `providers`, `issuerBanks`, `declineCodes`, `routingCoverage`, `fxRates`, `transactions`, `rollupMinute`, `rollupDeclinesMinute`, `incidents`, `investigationSteps`, `playbooks`).
- Produces: `db` (a `drizzle-orm/postgres-js` instance typed with the full schema) and `sql` (the raw `postgres` client), both exported from `packages/app/src/db/client.ts`. Task 4, 5 and 6 import `db` from here.

- [ ] **Step 1: Add dotenv as a dev dependency (tests need `.env` loaded; the running service reads real process env, see Task 8)**

Run: `pnpm --filter @control-tower/app add -D dotenv@^16.4.7`

- [ ] **Step 2: Point vitest at the repo-root `.env` via a setup file**

Create `packages/app/vitest.setup.ts`:

```ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../.env") });
```

Update `packages/app/vitest.config.ts` (from Task 2) to:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `packages/app/src/db/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sql } from "./client";

describe("db client", () => {
  it("connects to the database configured in .env", async () => {
    const rows = await sql<{ one: number }[]>`select 1 as one`;
    expect(rows[0]?.one).toBe(1);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test client.test`
Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 5: Implement the client**

Create `packages/app/src/db/client.ts`:

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — check .env");
}

export const sql = postgres(databaseUrl, { ssl: "prefer" });
export const db = drizzle(sql, { schema });
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `pnpm --filter @control-tower/app test client.test`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/app
git commit -m "feat(app): add postgres/drizzle client"
```

---

### Task 4: `insertTransactions` — idempotent bulk insert

**Files:**
- Create: `packages/app/src/ingest/insert-transactions.ts`
- Create: `packages/app/src/ingest/insert-transactions.integration.test.ts`

**Interfaces:**
- Consumes: `db` from `../db/client` (Task 3), `transactions` table from `../db/schema`, `TransactionEvent` from `@control-tower/contracts` (Task 1).
- Produces: `type Inserter = Pick<typeof db, "insert">` and `insertTransactions(dbClient: Inserter, events: TransactionEvent[]): Promise<Set<string>>`, exported from `packages/app/src/ingest/insert-transactions.ts`. The returned `Set` contains the `transactionId`s that were genuinely new (present in the DB's `RETURNING`). Task 6 (`processBatch`) depends on this exact signature and on `Inserter` to type its own transaction callback.

This task talks to the real Postgres instance from `.env` — there is no local test database in this project (see spec, "Fora de escopo"). Tests must clean up after themselves.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/ingest/insert-transactions.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { transactions } from "../db/schema";
import { insertTransactions } from "./insert-transactions";

function testEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    transactionId: randomUUID(),
    merchantOrderId: "order-test",
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 1000,
    fxRate: 5,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 200,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: null,
    latencyMs: null,
    createdAt: "2026-08-30T14:03:10.000Z",
    ...overrides,
  };
}

const insertedIds: string[] = [];

afterEach(async () => {
  if (insertedIds.length > 0) {
    await db.delete(transactions).where(inArray(transactions.transactionId, insertedIds));
    insertedIds.length = 0;
  }
});

describe("insertTransactions", () => {
  it("inserts new transactions and returns their ids", async () => {
    const event = testEvent();
    insertedIds.push(event.transactionId);

    const result = await insertTransactions(db, [event]);

    expect(result).toEqual(new Set([event.transactionId]));

    const [row] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.transactionId, event.transactionId));
    expect(row?.merchantId).toBe("merchant-1");
    expect(row?.amountMinor).toBe(1000);
  });

  it("does not insert the same transaction twice and excludes it from the returned set", async () => {
    const event = testEvent();
    insertedIds.push(event.transactionId);

    await insertTransactions(db, [event]);
    const secondResult = await insertTransactions(db, [event]);

    expect(secondResult.size).toBe(0);
  });

  it("returns an empty set for an empty batch without querying", async () => {
    const result = await insertTransactions(db, []);
    expect(result).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test insert-transactions`
Expected: FAIL — `Cannot find module './insert-transactions'`.

- [ ] **Step 3: Implement `insertTransactions`**

Create `packages/app/src/ingest/insert-transactions.ts`:

```ts
import type { TransactionEvent } from "@control-tower/contracts";
import { transactions } from "../db/schema";
import type { db } from "../db/client";

export type Inserter = Pick<typeof db, "insert">;

export async function insertTransactions(
  dbClient: Inserter,
  events: TransactionEvent[],
): Promise<Set<string>> {
  if (events.length === 0) {
    return new Set();
  }

  const rows = events.map((event) => ({
    transactionId: event.transactionId,
    merchantOrderId: event.merchantOrderId,
    merchantId: event.merchantId,
    providerId: event.providerId,
    country: event.country,
    paymentMethod: event.paymentMethod,
    currency: event.currency,
    amountMinor: event.amountMinor,
    // fx_rate is a plain `numeric` column — Drizzle's default mode for
    // numeric is `string`, to avoid silent float precision loss.
    fxRate: event.fxRate.toString(),
    fxRateDate: event.fxRateDate,
    fxSource: event.fxSource,
    amountUsdMinor: event.amountUsdMinor,
    status: event.status,
    declineCode: event.declineCode ?? null,
    rawDeclineCode: event.rawDeclineCode ?? null,
    cardBrand: event.cardBrand ?? null,
    cardType: event.cardType ?? null,
    cardBin: event.cardBin ?? null,
    issuerId: event.issuerId,
    token: event.token ?? null,
    latencyMs: event.latencyMs ?? null,
    createdAt: new Date(event.createdAt),
  }));

  const inserted = await dbClient
    .insert(transactions)
    .values(rows)
    .onConflictDoNothing({ target: transactions.transactionId })
    .returning({ transactionId: transactions.transactionId });

  return new Set(inserted.map((row) => row.transactionId));
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter @control-tower/app test insert-transactions`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors. If `fxRate` or `createdAt` complain about type mismatches, re-check against the actual column modes in `packages/app/src/db/schema.ts` — `numeric(...)` without `{ mode: "number" }` is `string`, `timestamp(...)` is `Date`, `bigint(..., { mode: "number" })` is `number`.

- [ ] **Step 6: Commit**

```bash
git add packages/app
git commit -m "feat(ingest): add idempotent bulk transaction insert"
```

---

### Task 5: Rollup upserts

**Files:**
- Create: `packages/app/src/ingest/upsert-rollups.ts`
- Create: `packages/app/src/ingest/upsert-rollups.integration.test.ts`

**Interfaces:**
- Consumes: `RollupMinuteDelta`, `RollupDeclineDelta` from `./rollup` (Task 2), `db`/`Inserter` pattern from Task 3/4, `rollupMinute`/`rollupDeclinesMinute` tables from `../db/schema`.
- Produces: `upsertRollupMinute(dbClient: Inserter, deltas: RollupMinuteDelta[]): Promise<void>` and `upsertRollupDeclinesMinute(dbClient: Inserter, deltas: RollupDeclineDelta[]): Promise<void>`, exported from `packages/app/src/ingest/upsert-rollups.ts`. Task 6 calls both.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/ingest/upsert-rollups.integration.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rollupMinute, rollupDeclinesMinute } from "../db/schema";
import { upsertRollupDeclinesMinute, upsertRollupMinute } from "./upsert-rollups";
import type { RollupDeclineDelta, RollupMinuteDelta } from "./rollup";

const TEST_BUCKET = new Date("2026-08-30T14:05:00.000Z");
const TEST_CELL = {
  bucket: TEST_BUCKET,
  merchantId: "merchant-upsert-test",
  providerId: "adyen",
  country: "BR" as const,
  paymentMethod: "CARD" as const,
  issuerId: "itau",
};

async function cleanup() {
  await db
    .delete(rollupMinute)
    .where(
      and(
        eq(rollupMinute.bucket, TEST_BUCKET),
        eq(rollupMinute.merchantId, TEST_CELL.merchantId),
      ),
    );
  await db
    .delete(rollupDeclinesMinute)
    .where(
      and(
        eq(rollupDeclinesMinute.bucket, TEST_BUCKET),
        eq(rollupDeclinesMinute.merchantId, TEST_CELL.merchantId),
      ),
    );
}

afterEach(cleanup);

describe("upsertRollupMinute", () => {
  it("inserts a new cell", async () => {
    const delta: RollupMinuteDelta = {
      ...TEST_CELL,
      attempts: 3,
      approved: 2,
      amountMinorSum: 3000,
      amountUsdSum: 600,
      approvedUsdSum: 400,
    };

    await upsertRollupMinute(db, [delta]);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(
        and(
          eq(rollupMinute.bucket, TEST_BUCKET),
          eq(rollupMinute.merchantId, TEST_CELL.merchantId),
        ),
      );
    expect(row).toMatchObject({ attempts: 3, approved: 2, amountMinorSum: 3000 });
  });

  it("adds to an existing cell instead of overwriting it", async () => {
    const first: RollupMinuteDelta = {
      ...TEST_CELL,
      attempts: 3,
      approved: 2,
      amountMinorSum: 3000,
      amountUsdSum: 600,
      approvedUsdSum: 400,
    };
    const second: RollupMinuteDelta = {
      ...TEST_CELL,
      attempts: 1,
      approved: 0,
      amountMinorSum: 500,
      amountUsdSum: 100,
      approvedUsdSum: 0,
    };

    await upsertRollupMinute(db, [first]);
    await upsertRollupMinute(db, [second]);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(
        and(
          eq(rollupMinute.bucket, TEST_BUCKET),
          eq(rollupMinute.merchantId, TEST_CELL.merchantId),
        ),
      );
    expect(row).toMatchObject({ attempts: 4, approved: 2, amountMinorSum: 3500 });
  });
});

describe("upsertRollupDeclinesMinute", () => {
  it("adds counts per decline_code instead of overwriting", async () => {
    const delta: RollupDeclineDelta = { ...TEST_CELL, declineCode: "05", count: 2 };

    await upsertRollupDeclinesMinute(db, [delta]);
    await upsertRollupDeclinesMinute(db, [{ ...delta, count: 1 }]);

    const [row] = await db
      .select()
      .from(rollupDeclinesMinute)
      .where(
        and(
          eq(rollupDeclinesMinute.bucket, TEST_BUCKET),
          eq(rollupDeclinesMinute.merchantId, TEST_CELL.merchantId),
          eq(rollupDeclinesMinute.declineCode, "05"),
        ),
      );
    expect(row?.count).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test upsert-rollups`
Expected: FAIL — `Cannot find module './upsert-rollups'`.

- [ ] **Step 3: Implement the upserts**

Create `packages/app/src/ingest/upsert-rollups.ts`:

```ts
import { sql } from "drizzle-orm";
import { rollupDeclinesMinute, rollupMinute } from "../db/schema";
import type { Inserter } from "./insert-transactions";
import type { RollupDeclineDelta, RollupMinuteDelta } from "./rollup";

export async function upsertRollupMinute(
  dbClient: Inserter,
  deltas: RollupMinuteDelta[],
): Promise<void> {
  if (deltas.length === 0) {
    return;
  }

  await dbClient
    .insert(rollupMinute)
    .values(
      deltas.map((delta) => ({
        bucket: delta.bucket,
        merchantId: delta.merchantId,
        providerId: delta.providerId,
        country: delta.country,
        paymentMethod: delta.paymentMethod,
        issuerId: delta.issuerId,
        attempts: delta.attempts,
        approved: delta.approved,
        amountMinorSum: delta.amountMinorSum,
        amountUsdSum: delta.amountUsdSum,
        approvedUsdSum: delta.approvedUsdSum,
      })),
    )
    .onConflictDoUpdate({
      target: [
        rollupMinute.bucket,
        rollupMinute.merchantId,
        rollupMinute.providerId,
        rollupMinute.country,
        rollupMinute.paymentMethod,
        rollupMinute.issuerId,
      ],
      set: {
        attempts: sql`${rollupMinute.attempts} + excluded.attempts`,
        approved: sql`${rollupMinute.approved} + excluded.approved`,
        amountMinorSum: sql`${rollupMinute.amountMinorSum} + excluded.amount_minor_sum`,
        amountUsdSum: sql`${rollupMinute.amountUsdSum} + excluded.amount_usd_sum`,
        approvedUsdSum: sql`${rollupMinute.approvedUsdSum} + excluded.approved_usd_sum`,
      },
    });
}

export async function upsertRollupDeclinesMinute(
  dbClient: Inserter,
  deltas: RollupDeclineDelta[],
): Promise<void> {
  if (deltas.length === 0) {
    return;
  }

  await dbClient
    .insert(rollupDeclinesMinute)
    .values(
      deltas.map((delta) => ({
        bucket: delta.bucket,
        merchantId: delta.merchantId,
        providerId: delta.providerId,
        country: delta.country,
        paymentMethod: delta.paymentMethod,
        issuerId: delta.issuerId,
        declineCode: delta.declineCode,
        count: delta.count,
      })),
    )
    .onConflictDoUpdate({
      target: [
        rollupDeclinesMinute.bucket,
        rollupDeclinesMinute.merchantId,
        rollupDeclinesMinute.providerId,
        rollupDeclinesMinute.country,
        rollupDeclinesMinute.paymentMethod,
        rollupDeclinesMinute.issuerId,
        rollupDeclinesMinute.declineCode,
      ],
      set: {
        count: sql`${rollupDeclinesMinute.count} + excluded.count`,
      },
    });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter @control-tower/app test upsert-rollups`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app
git commit -m "feat(ingest): add additive rollup upserts"
```

---

### Task 6: `processBatch` — transactional orchestration + idempotency

**Files:**
- Modify: `packages/app/src/ingest/rollup.ts` (add `processBatch`, re-export from the same file since it's the module's public entrypoint)
- Create: `packages/app/src/ingest/process-batch.integration.test.ts`

**Interfaces:**
- Consumes: `insertTransactions` (Task 4), `upsertRollupMinute`/`upsertRollupDeclinesMinute` (Task 5), `aggregateDeltas` (Task 2, same file), `db` (Task 3).
- Produces: `processBatch(events: TransactionEvent[]): Promise<{ insertedCount: number }>`, exported from `packages/app/src/ingest/rollup.ts`. Task 7 (`consumer.ts`) is the only caller.

This is the task that proves the idempotency claim from the spec and from `flight_logs/ingestao_em_micro_batch_com_dedup.md`: processing the same batch twice must leave the rollups identical to processing it once.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/ingest/process-batch.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { transactions, rollupMinute } from "../db/schema";
import { processBatch } from "./rollup";

const BUCKET = new Date("2026-08-30T14:07:00.000Z");
// `processBatch` inserts into `transactions`, which has a NOT NULL FK to
// `merchants` — use a real seeded merchant id (BR_STORE_01), never a
// fabricated one, so this test never has to touch the shared catalog table.
const MERCHANT_ID = "BR_STORE_01";

function testEvent(id: string, overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    transactionId: id,
    merchantOrderId: `order-${id}`,
    merchantId: MERCHANT_ID,
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 1000,
    fxRate: 5,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 200,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: null,
    latencyMs: null,
    createdAt: "2026-08-30T14:07:10.000Z",
    ...overrides,
  };
}

const usedIds: string[] = [];

afterEach(async () => {
  if (usedIds.length > 0) {
    await db.delete(transactions).where(inArray(transactions.transactionId, usedIds));
  }
  await db
    .delete(rollupMinute)
    .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
  usedIds.length = 0;
});

describe("processBatch", () => {
  it("inserts transactions and updates rollups together", async () => {
    const id = randomUUID();
    usedIds.push(id);

    const result = await processBatch([testEvent(id)]);

    expect(result.insertedCount).toBe(1);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
    expect(row).toMatchObject({ attempts: 1, approved: 1 });
  });

  it("is idempotent under exact redelivery: processing the same batch twice leaves rollups unchanged", async () => {
    const id = randomUUID();
    usedIds.push(id);
    const event = testEvent(id);

    const first = await processBatch([event]);
    const second = await processBatch([event]);

    expect(first.insertedCount).toBe(1);
    expect(second.insertedCount).toBe(0);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
    expect(row).toMatchObject({ attempts: 1, approved: 1 });
  });

  it("is idempotent for a mixed batch: only the genuinely new events affect the rollup", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    usedIds.push(idA, idB);

    await processBatch([testEvent(idA)]);
    const result = await processBatch([testEvent(idA), testEvent(idB)]);

    expect(result.insertedCount).toBe(1);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(and(eq(rollupMinute.bucket, BUCKET), eq(rollupMinute.merchantId, MERCHANT_ID)));
    expect(row).toMatchObject({ attempts: 2, approved: 2 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test process-batch`
Expected: FAIL — `processBatch is not exported from './rollup'`.

- [ ] **Step 3: Add `processBatch` to `packages/app/src/ingest/rollup.ts`**

Two edits to the existing `packages/app/src/ingest/rollup.ts` from Task 2 —
don't create a new file and don't duplicate the existing
`import type { TransactionEvent } from "@control-tower/contracts";` line.

First, add three new imports to the import block already at the top of the
file, so it reads:

```ts
import type { TransactionEvent } from "@control-tower/contracts";
import { db } from "../db/client";
import { insertTransactions } from "./insert-transactions";
import { upsertRollupDeclinesMinute, upsertRollupMinute } from "./upsert-rollups";
```

Then append this function at the bottom of the file, after `aggregateDeltas`
(everything from Task 2 — `floorToMinute`, `cellKey`, the exported types,
`aggregateDeltas` itself — stays exactly as it is, untouched):

```ts
export async function processBatch(
  events: TransactionEvent[],
): Promise<{ insertedCount: number }> {
  return db.transaction(async (tx) => {
    const insertedIds = await insertTransactions(tx, events);
    const newEvents = events.filter((event) => insertedIds.has(event.transactionId));
    const { minuteDeltas, declineDeltas } = aggregateDeltas(newEvents);

    await upsertRollupMinute(tx, minuteDeltas);
    await upsertRollupDeclinesMinute(tx, declineDeltas);

    return { insertedCount: insertedIds.size };
  });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter @control-tower/app test process-batch`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Run the full app test suite**

Run: `pnpm --filter @control-tower/app test`
Expected: every test in `packages/app` passes (rollup, client, insert-transactions, upsert-rollups, process-batch).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors. If `tx` doesn't structurally satisfy `Inserter`, check that `Inserter` in `insert-transactions.ts` is exactly `Pick<typeof db, "insert">` — narrowing to that one method is what makes both `db` and the transaction callback's `tx` argument compatible.

- [ ] **Step 7: Commit**

```bash
git add packages/app
git commit -m "feat(ingest): add processBatch, proving idempotency under redelivery"
```

---

### Task 7: Redis consumer

**Files:**
- Modify: `packages/app/package.json` (add `ioredis`, `pino`)
- Create: `packages/app/src/ingest/consumer.ts`

**Interfaces:**
- Consumes: `transactionEventSchema` and `TransactionEvent` from `@control-tower/contracts`, `processBatch` from `./rollup` (Task 6).
- Produces: `startConsumer(): Promise<never>`, exported from `packages/app/src/ingest/consumer.ts`. Task 8 (`run.ts`) is the only caller.

No automated tests for this task — per the approved spec's testing section, only `aggregateDeltas`, `transactionEventSchema`, and the `processBatch` idempotency path get automated coverage; the Redis plumbing here is thin and is verified manually in Task 8 against the real stream. Do still follow steps in order and run the compiler after writing the code.

- [ ] **Step 1: Add `ioredis` and `pino`**

Run: `pnpm --filter @control-tower/app add ioredis@^5.4.1 pino@^9.5.0`

- [ ] **Step 2: Implement the consumer**

Create `packages/app/src/ingest/consumer.ts`:

```ts
import Redis from "ioredis";
import pino from "pino";
import { transactionEventSchema, type TransactionEvent } from "@control-tower/contracts";
import { processBatch } from "./rollup";

const logger = pino({ name: "ingest-consumer" });

const STREAM_KEY = "stream:transactions";
const GROUP_NAME = "ingest";
const CONSUMER_NAME = "app-1";
const BATCH_SIZE = 100;
const BLOCK_MS = 500;
const MAX_DB_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 200;

type RawStreamEntry = [id: string, fields: string[]];
type RawReadGroupReply = [streamKey: string, entries: RawStreamEntry[]][] | null;
type RawAutoClaimReply = [cursor: string, entries: RawStreamEntry[], deletedIds: string[]];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  } catch (error) {
    const isBusyGroup = error instanceof Error && error.message.includes("BUSYGROUP");
    if (!isBusyGroup) {
      throw error;
    }
  }
}

function parseEntries(rawEntries: RawStreamEntry[]): {
  valid: { id: string; event: TransactionEvent }[];
  invalidIds: string[];
} {
  const valid: { id: string; event: TransactionEvent }[] = [];
  const invalidIds: string[] = [];

  for (const [id, fields] of rawEntries) {
    const payloadIndex = fields.indexOf("payload");
    const rawPayload = payloadIndex >= 0 ? fields[payloadIndex + 1] : undefined;

    if (!rawPayload) {
      logger.error({ id }, "stream entry is missing the payload field");
      invalidIds.push(id);
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawPayload);
    } catch (error) {
      logger.error({ id, rawPayload, error }, "payload is not valid JSON");
      invalidIds.push(id);
      continue;
    }

    const result = transactionEventSchema.safeParse(parsedJson);
    if (!result.success) {
      logger.error(
        { id, rawPayload, issues: result.error.issues },
        "payload failed schema validation",
      );
      invalidIds.push(id);
      continue;
    }

    valid.push({ id, event: result.data });
  }

  return { valid, invalidIds };
}

async function processBatchWithRetry(events: TransactionEvent[]): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await processBatch(events);
      return;
    } catch (error) {
      attempt += 1;
      logger.error({ attempt, error }, "batch processing failed");
      if (attempt >= MAX_DB_RETRIES) {
        logger.fatal({ error }, "giving up after max retries, exiting process");
        process.exit(1);
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

async function handleEntries(redis: Redis, rawEntries: RawStreamEntry[]): Promise<void> {
  if (rawEntries.length === 0) {
    return;
  }

  const { valid, invalidIds } = parseEntries(rawEntries);

  if (valid.length > 0) {
    await processBatchWithRetry(valid.map((entry) => entry.event));
  }

  const allIds = [...valid.map((entry) => entry.id), ...invalidIds];
  if (allIds.length > 0) {
    await redis.xack(STREAM_KEY, GROUP_NAME, ...allIds);
  }
}

async function reclaimPending(redis: Redis): Promise<void> {
  const reply = (await redis.call(
    "XAUTOCLAIM",
    STREAM_KEY,
    GROUP_NAME,
    CONSUMER_NAME,
    "0",
    "0",
  )) as RawAutoClaimReply;

  const [, entries] = reply;
  await handleEntries(redis, entries);
}

export async function startConsumer(): Promise<never> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not set — check .env");
  }

  const redis = new Redis(redisUrl);

  await ensureConsumerGroup(redis);
  await reclaimPending(redis);
  logger.info({ stream: STREAM_KEY, group: GROUP_NAME }, "ingest consumer started");

  for (;;) {
    const reply = (await redis.call(
      "XREADGROUP",
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      BATCH_SIZE,
      "BLOCK",
      BLOCK_MS,
      "STREAMS",
      STREAM_KEY,
      ">",
    )) as RawReadGroupReply;

    if (!reply) {
      continue;
    }

    const [, entries] = reply[0];
    await handleEntries(redis, entries);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/app
git commit -m "feat(ingest): add Redis consumer group loop with crash recovery"
```

---

### Task 8: Entrypoint and manual end-to-end verification

**Files:**
- Create: `packages/app/src/ingest/run.ts`
- Modify: `packages/app/package.json` (add `ingest:dev` script, `tsx`)

**Interfaces:**
- Consumes: `startConsumer` from `./consumer` (Task 7).
- Produces: nothing consumed by later tasks — this is the runnable entrypoint for the whole subsystem this plan builds.

- [ ] **Step 1: Add `tsx`**

Run: `pnpm --filter @control-tower/app add -D tsx@^4.19.2`

- [ ] **Step 2: Write the entrypoint**

Create `packages/app/src/ingest/run.ts`:

```ts
import { config } from "dotenv";
import { resolve } from "node:path";
import { startConsumer } from "./consumer";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

startConsumer().catch((error) => {
  console.error("ingest consumer crashed:", error);
  process.exit(1);
});
```

- [ ] **Step 3: Add the dev script**

In `packages/app/package.json`, add to `"scripts"`:

```json
"ingest:dev": "tsx watch src/ingest/run.ts"
```

- [ ] **Step 4: Manually verify against the real stream**

This is the task's test — there's no automated coverage for the Redis loop (see Task 7). Run these two commands in separate terminals from the repo root.

Terminal 1:
```bash
pnpm --filter @control-tower/app ingest:dev
```
Expected log line: `"ingest consumer started"` with `stream: "stream:transactions"`, `group: "ingest"`.

Terminal 2 — hand-craft one event and push it onto the stream with `redis-cli` (or any Redis client pointed at the `REDIS_URL` from `.env`):
```bash
redis-cli -u "$REDIS_URL" XADD stream:transactions '*' payload '{"transactionId":"11111111-1111-4111-8111-111111111111","merchantOrderId":"manual-check","merchantId":"BR_STORE_01","providerId":"adyen","country":"BR","paymentMethod":"CARD","currency":"BRL","amountMinor":1000,"fxRate":5,"fxRateDate":"2026-08-30","fxSource":"MOCK","amountUsdMinor":200,"status":"SUCCESS","declineCode":null,"rawDeclineCode":null,"cardBrand":"visa","cardType":"credit","cardBin":"411111","issuerId":"itau","token":null,"latencyMs":null,"createdAt":"2026-08-30T14:03:00.000Z"}'
```

Expected: Terminal 1 shows no error output for this event (a clean batch produces no log line by design — only errors and the startup line are logged). Confirm it landed by querying Postgres directly:
```bash
psql "$DATABASE_URL" -c "select transaction_id, merchant_id, amount_minor from transactions where transaction_id = '11111111-1111-4111-8111-111111111111';"
psql "$DATABASE_URL" -c "select bucket, merchant_id, attempts, approved from rollup_minute where merchant_id = 'BR_STORE_01' and bucket = '2026-08-30 14:03:00+00';"
```
Expected: one row in `transactions` with `amount_minor = 1000`, one row in `rollup_minute` with `attempts = 1, approved = 1`.

Re-run the same `XADD` + verification a second time with a **new** `transactionId` but otherwise identical data to confirm a second independent event accumulates correctly (`attempts = 2` in the same bucket).

Clean up the manual test rows before moving on:
```bash
psql "$DATABASE_URL" -c "delete from transactions where merchant_order_id = 'manual-check';"
psql "$DATABASE_URL" -c "delete from rollup_minute where merchant_id = 'BR_STORE_01' and bucket = '2026-08-30 14:03:00+00';"
```

Stop the consumer (Ctrl+C in Terminal 1) once verified.

- [ ] **Step 5: Run the full test suite and typecheck one more time**

Run:
```bash
pnpm --filter @control-tower/contracts test
pnpm --filter @control-tower/contracts typecheck
pnpm --filter @control-tower/app test
pnpm --filter @control-tower/app typecheck
```
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add packages/app
git commit -m "feat(ingest): add runnable entrypoint for the ingest consumer"
```

- [ ] **Step 7: Push the feature branch**

```bash
git push -u origin feature/ingest
```
