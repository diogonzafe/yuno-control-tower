# Conversion Drop Detector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, DB-agnostic core of the conversion-drop detector as pure functions over rollup-row arrays, emitting a typed `ConfirmedDrop` signal.

**Architecture:** Pure layered modules in `packages/app/src/detect/` (Wilson interval, parametrized aggregation, expected-rate, absolute + cross-sectional triggers, 3-window persistence with temporal dedup, retro onset-scan) composed by one explicit-state `runDetectionTick`. No database, no stream ingest, no orchestrator, no agent. Output contracts are Zod schemas in `packages/contracts`.

**Tech Stack:** Node 22, TypeScript strict/ESM, pnpm workspaces, Zod, Vitest. No statistics library (Wilson is closed-form).

**Spec:** [context/detector.md](../../../context/detector.md) (`YCT-DETECT-001`). Read it and [flight_logs/wilson_detection.md](../../../flight_logs/wilson_detection.md) before starting. Domain background: `context/spec.md` §1, `context/schema.md` §6, `context/roadmap.md` §2.

## Global Constraints

- **Runtime:** Node ≥ 22, TypeScript `strict: true`, ESM (`"type": "module"`), `moduleResolution: "NodeNext"`.
- **No new production dependencies.** Wilson is ~8 lines (`context/rules.md` §6.1). Zod is already a `contracts` dependency.
- **Language:** all code, identifiers, filenames, test names, commit messages in English (`context/rules.md` §2). Context docs stay in Portuguese.
- **Comments:** only for non-obvious *why*, citing decisions (`DD8`, `DD11`, …). Never narrate what the code does (`context/rules.md` §2).
- **TDD:** red-green-refactor, test before implementation, every task (`context/rules.md` §4, `AGENTS.md`).
- **Determinism:** no `Date.now()`, no I/O, no time mocks in detector code or its tests. Fixtures are hand-computed.
- **DRY:** exactly one aggregation implementation (`aggregate.ts`); `approved / attempts` is never re-derived elsewhere (`context/rules.md` §1, `AGENTS.md`).
- **Locked constants** (`context/detector.md` §4, do not change): `MIN_VOLUME = 30`, `Z = 1.96`, `DELTA_PP_DEFAULT = 3.0`, `PERSISTENCE_WINDOWS = 3`, `THIN_CELL_WINDOW_MIN = 5`, `ONSET_LOOKBACK_MIN = 120`, `TEMPORAL_LOOKBACK_MIN = 360`.
- **Cube facts:** 5 conversion dimensions (merchant, provider, country, payment_method, issuer). `decline_code` is NOT a conversion dimension. `PIX` exists only in `BR`; PIX rows carry `issuerId = "NA"`. Countries: `BR`, `MX`, `AR`. Full provider×country mesh (DD13).
- **Boundary:** the detector emits `ConfirmedDrop` / `EvidenceGap` in memory and stops. It never writes `incidents`, computes cost, analyzes decline-mix, runs a residual test, or calls an LLM.
- **Commit** at the end of every task. Never `git commit` outside a task's final step. Do not amend.
- **Environment:** `pnpm` is NOT on `PATH` on this machine. Invoke it as `"$APPDATA/npm/pnpm"` in Bash (e.g. `"$APPDATA/npm/pnpm" --filter @control-tower/app test`). `node`, `npx`, `git` are on `PATH`. Docker daemon and `psql` are unavailable.
- **Seed data:** a Railway Postgres holds fictitious 2026-08 data (READ ONLY; `DATABASE_URL` in `.env` — do not print or commit it). The detector is DB-agnostic, so no task connects to it; fixtures must nonetheless use the real IDs below so a later SQL-layer branch needs no fixture rewrite.

## Seed Data Reference (READ ONLY)

Verified against the live DB. Use these exact IDs in every fixture and test.

- **Providers:** `stripe`, `adyen`, `mercado_pago` (note: `mercado_pago`, not `mpago`).
- **Merchants** — each belongs to exactly one country (the cube's merchant dimension carries country):
  - BR: `BR_STORE_01` (exp 0.92), `BR_STORE_02` (0.89), `BR_STORE_03` (0.94)
  - MX: `MX_STORE_01` (0.91), `MX_STORE_02` (0.93), `MX_STORE_03` (0.89)
  - AR: `AR_STORE_01` (0.87), `AR_STORE_02` (0.90), `AR_STORE_03` (0.88)
  - all merchants: `min_material_drop_pp = 3`.
- **Issuers** (3 per country) + `NA` for PIX:
  - BR: `itau`, `nubank`, `bradesco`
  - MX: `bbva_mx`, `banorte`, `citibanamex`
  - AR: `galicia`, `santander_rio`, `macro`
- **`routing_coverage`:** 12 rows — every provider × every country (CARD) + every provider × BR (PIX). PIX only in BR.
- **Rollup tables** (`rollup_minute`, `rollup_declines_minute`) are populated for 2026-08-28..29; `incidents` is empty. Not used by this branch.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `tsconfig.base.json` | Root TS config: strict, ESM, NodeNext, ES2022. |
| `packages/contracts/tsconfig.json` | Extends base. |
| `packages/app/tsconfig.json` | Extends base, adds `node` types. |
| `packages/app/vitest.config.ts` | Vitest: node env, `src/**/*.test.ts`. |
| `packages/contracts/src/incident.ts` | Zod: `CellState`, `Dimensions`, `ExpectedSource`, `ConfirmedDrop`, `EvidenceGap`. |
| `packages/app/src/detect/constants.ts` | The 7 locked tuning constants, each with a DD reference. |
| `packages/app/src/detect/types.ts` | `Dimension`, `SliceFilter`, `RollupRow`, `MerchantConfig`, `RoutingCoverage`. |
| `packages/app/src/db/queries.ts` | `RollupSource` interface — signature only, no implementation. |
| `packages/app/src/detect/wilson.ts` | `wilson()`, `evaluate()`, `Interval`, `CellState` state machine. |
| `packages/app/src/detect/fixtures.ts` | Test builders: `rollupRow`, `merchant`, `fullCoverage`. |
| `packages/app/src/detect/aggregate.ts` | `aggregate()`, `aggregateByBucket()`, `matchesFilter()`, `AggResult`. |
| `packages/app/src/detect/expected.ts` | `crossSectionalExpected()`, `temporalExpected()`. |
| `packages/app/src/detect/trigger.ts` | `Candidate`, `absoluteTrigger()`, `crossSectionalSweep()`. |
| `packages/app/src/detect/persistence.ts` | `PersistenceEntry`, `PersistenceState`, `fingerprint()`, `step()`. |
| `packages/app/src/detect/onset-scan.ts` | `onsetScan()`. |
| `packages/app/src/detect/tick.ts` | `runDetectionTick()`. |
| `packages/app/src/detect/*.test.ts` | One test file per module above (except `types`/`constants` share `scaffold.test.ts`, and `fixtures` is exercised via other tests). |

**Modify:**

| Path | Change |
|---|---|
| `packages/contracts/src/index.ts` | `export {}` → `export * from "./incident";` |
| `packages/contracts/package.json` | + `typecheck` script. |
| `packages/app/package.json` | + `@control-tower/contracts` dep; + `vitest`, `@types/node` devDeps; + `test`, `test:watch`, `typecheck` scripts. |
| `package.json` (root) | + `test`, `typecheck` scripts running `pnpm -r`. |
| `pnpm-lock.yaml` | Regenerated by `pnpm install`. |
| `AGENTS.md` | Replace the stale "beta-binomial conflict — do not implement" note; bump front-matter `time:`. |
| `context/schema.md` | §6: one-line pointer to `context/detector.md` for the sweep root. |

---

## Task 1: Docs reconciliation + spec commit

**Files:**
- Modify: `AGENTS.md` (lines 45-49 region + front-matter `time:`)
- Modify: `context/schema.md` (§6, "Consequências a declarar no decision log" area)
- Commit (already on disk from brainstorming): `context/detector.md`, `flight_logs/wilson_detection.md`, `flight_logs/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-facing. Unblocks the repo rule in `AGENTS.md` that forbids touching detector statistics until the Wilson-vs-beta-binomial conflict is resolved.

- [ ] **Step 1: Rewrite the stale AGENTS.md note**

In `AGENTS.md`, find this paragraph (around line 45):

```
Conflito conhecido na documentação: DD11 em `context/schema.md` especifica um
teste beta-binomial, enquanto partes de `context/roadmap.md` e
`context/rules.md` citam intervalo de Wilson. Não implemente nem altere a
estatística do detector até o usuário confirmar a escolha autoritativa e os
arquivos de contexto afetados ficarem consistentes.
```

Replace it with:

```
DD11 está resolvido: o teste do detector é o **intervalo de Wilson** (fórmula
fechada, `z = 1.96`, persistência de 3 janelas). `context/schema.md` §6.3 é a
referência normativa; o registro da decisão está em
`flight_logs/wilson_detection.md`. O spec do detector é `context/detector.md`
(`YCT-DETECT-001`).
```

- [ ] **Step 2: Bump the AGENTS.md front-matter timestamp**

In `AGENTS.md` front matter, change the `time:` value to the current UTC RFC-3339 timestamp (run `date -u +"%Y-%m-%dT%H:%M:%SZ"` to get it). This is a substantive change, so the bump is required (`context/rules.md` §2.1).

- [ ] **Step 3: Add the sweep-root pointer to schema.md**

In `context/schema.md` §6, in the bullet list under "Consequências a declarar no decision log", after the bullet that begins "**O gatilho roda em dois níveis**", add a new bullet:

```
- **Raiz da varredura transversal de profundidade 1 = `merchant × país`** (não
  "filhos da raiz" global), dividindo por provider, emissor e método. É o que
  cobre "emissor cai para um único merchant". Detalhe e justificativa em
  `context/detector.md` §5.4 e `flight_logs/wilson_detection.md`.
```

- [ ] **Step 4: Verify no other doc still contradicts Wilson**

Run: `grep -rn "beta-binomial\|beta binomial" . --include=*.md`
Expected: matches only in `flight_logs/wilson_detection.md` (where it is named as a rejected option) and `context/schema.md` line ~4 (the v3 changelog line "sai o beta-binomial em favor do intervalo de Wilson", which is correct history). No match in `AGENTS.md`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md context/schema.md context/detector.md flight_logs/wilson_detection.md flight_logs/README.md
git commit -m "docs: detector spec (YCT-DETECT-001) + Wilson flight log; reconcile AGENTS/schema"
```

---

## Task 2: Toolchain + `@control-tower/contracts`

**Files:**
- Create: `tsconfig.base.json`, `packages/app/tsconfig.json`, `packages/contracts/tsconfig.json`, `packages/app/vitest.config.ts`
- Create: `packages/contracts/src/incident.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/package.json`, `packages/app/package.json`, `package.json`
- Test: `packages/app/src/detect/contracts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `@control-tower/contracts` exports (values *and* inferred types, same names):
    - `CellState` — Zod enum `"MATERIAL_DROP" | "HEALTHY" | "MONITORING" | "INSUFFICIENT_EVIDENCE"`
    - `Dimensions` — Zod object, all 5 keys `.partial()`
    - `ExpectedSource` — Zod enum `"cross_sectional" | "temporal" | "absolute"`
    - `ConfirmedDrop` — Zod object (see Step 4 for exact fields)
    - `EvidenceGap` — Zod object `{ dimensions, windowBucket, attempts, reason: "INSUFFICIENT_EVIDENCE" }`
  - `pnpm --filter @control-tower/app test` and `pnpm -r typecheck` both runnable.

- [ ] **Step 1: Create `tsconfig.base.json` (repo root)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  }
}
```

- [ ] **Step 2: Create the package tsconfigs**

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

`packages/app/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `packages/app/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Edit `packages/app/package.json`**

Set the file to exactly:

```json
{
  "name": "@control-tower/app",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@control-tower/contracts": "workspace:*",
    "drizzle-orm": "^0.36.4",
    "postgres": "^3.4.5"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 5: Edit `packages/contracts/package.json`**

Add a `typecheck` script. The file becomes:

```json
{
  "name": "@control-tower/contracts",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 6: Edit the root `package.json`**

Add `test` and `typecheck` to `scripts`. Result:

```json
{
  "name": "control-tower",
  "private": true,
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:migrate": "drizzle-kit migrate",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "dotenv": "^16.4.7",
    "drizzle-kit": "^0.28.1",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 7: Install**

Run: `"$APPDATA/npm/pnpm" install` (pnpm is not on `PATH` — see Global Constraints; use this exact form for every `pnpm` command in every task).
Expected: resolves, writes `pnpm-lock.yaml`, links `@control-tower/contracts` into `packages/app/node_modules`. The "Ignored build scripts: esbuild" warning is expected and harmless.

- [ ] **Step 8: Write the failing contract test**

Create `packages/app/src/detect/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CellState,
  ConfirmedDrop,
  EvidenceGap,
} from "@control-tower/contracts";

const validSignal = {
  dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
  windowBucket: "2026-08-30T14:06:00.000Z",
  observedRate: 0.41,
  expectedRate: 0.95,
  expectedSource: "cross_sectional",
  deltaPp: 3,
  ciLow: 0.36,
  ciHigh: 0.46,
  ciLevel: 0.95,
  attempts: 420,
  approved: 172,
  windowUsed: "1m",
  startedAt: "2026-08-30T14:03:00.000Z",
  startedAtExact: true,
  consecutiveWindows: 3,
};

describe("contracts", () => {
  it("accepts a well-formed ConfirmedDrop", () => {
    expect(() => ConfirmedDrop.parse(validSignal)).not.toThrow();
  });

  it("rejects a ConfirmedDrop missing ciLow", () => {
    const { ciLow, ...bad } = validSignal;
    expect(() => ConfirmedDrop.parse(bad)).toThrow();
  });

  it("rejects an unknown CellState", () => {
    expect(() => CellState.parse("WOBBLY")).toThrow();
  });

  it("accepts an EvidenceGap and pins the reason literal", () => {
    const gap = {
      dimensions: { merchantId: "MX_STORE_01", country: "MX" },
      windowBucket: "2026-08-30T14:06:00.000Z",
      attempts: 7,
      reason: "INSUFFICIENT_EVIDENCE",
    };
    expect(() => EvidenceGap.parse(gap)).not.toThrow();
    expect(() => EvidenceGap.parse({ ...gap, reason: "OTHER" })).toThrow();
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `pnpm --filter @control-tower/app test`
Expected: FAIL — `Cannot find module '@control-tower/contracts'` resolves, but `ConfirmedDrop` etc. are `undefined` (index.ts is still `export {}`).

- [ ] **Step 10: Write `packages/contracts/src/incident.ts`**

```ts
import { z } from "zod";

export const CellState = z.enum([
  "MATERIAL_DROP",
  "HEALTHY",
  "MONITORING",
  "INSUFFICIENT_EVIDENCE",
]);
export type CellState = z.infer<typeof CellState>;

// A slice fixes a subset of the 5 conversion dimensions.
export const Dimensions = z
  .object({
    merchantId: z.string(),
    providerId: z.string(),
    country: z.enum(["BR", "MX", "AR"]),
    paymentMethod: z.enum(["CARD", "PIX"]),
    issuerId: z.string(),
  })
  .partial();
export type Dimensions = z.infer<typeof Dimensions>;

export const ExpectedSource = z.enum(["cross_sectional", "temporal", "absolute"]);
export type ExpectedSource = z.infer<typeof ExpectedSource>;

// Confirmed signal: MATERIAL_DROP persisting PERSISTENCE_WINDOWS windows.
// Emitted once per slice (temporal dedup in persistence.ts).
export const ConfirmedDrop = z.object({
  dimensions: Dimensions,
  windowBucket: z.string().datetime(),
  observedRate: z.number(),
  expectedRate: z.number(),
  expectedSource: ExpectedSource,
  deltaPp: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  ciLevel: z.number(),
  attempts: z.number().int(),
  approved: z.number().int(),
  windowUsed: z.enum(["1m", "5m"]),
  startedAt: z.string().datetime(),
  startedAtExact: z.boolean(),
  consecutiveWindows: z.number().int(),
});
export type ConfirmedDrop = z.infer<typeof ConfirmedDrop>;

// A slice with too little volume to assert anything (spec §5 bonus:
// "the system admits the evidence is not enough").
export const EvidenceGap = z.object({
  dimensions: Dimensions,
  windowBucket: z.string().datetime(),
  attempts: z.number().int(),
  reason: z.literal("INSUFFICIENT_EVIDENCE"),
});
export type EvidenceGap = z.infer<typeof EvidenceGap>;
```

- [ ] **Step 11: Rewrite `packages/contracts/src/index.ts`**

```ts
export * from "./incident";
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `pnpm --filter @control-tower/app test`
Expected: PASS — 4 tests green.

- [ ] **Step 13: Typecheck**

Run: `pnpm -r typecheck`
Expected: no errors in `@control-tower/contracts` or `@control-tower/app`.

- [ ] **Step 14: Commit**

```bash
git add tsconfig.base.json packages/contracts packages/app/tsconfig.json packages/app/vitest.config.ts packages/app/package.json package.json pnpm-lock.yaml packages/app/src/detect/contracts.test.ts
git commit -m "add: TS/Vitest toolchain and @control-tower/contracts detector schemas"
```

---

## Task 3: Scaffolding — `constants.ts`, `types.ts`, `db/queries.ts`

**Files:**
- Create: `packages/app/src/detect/constants.ts`
- Create: `packages/app/src/detect/types.ts`
- Create: `packages/app/src/db/queries.ts`
- Test: `packages/app/src/detect/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `constants.ts`: `MIN_VOLUME=30`, `Z=1.96`, `DELTA_PP_DEFAULT=3.0`, `PERSISTENCE_WINDOWS=3`, `THIN_CELL_WINDOW_MIN=5`, `ONSET_LOOKBACK_MIN=120`, `TEMPORAL_LOOKBACK_MIN=360` (all `number`).
  - `types.ts`:
    - `type Dimension = "merchantId" | "providerId" | "country" | "paymentMethod" | "issuerId"`
    - `type SliceFilter = Partial<Record<Dimension, string>>`
    - `type RollupRow = { bucket: string; merchantId: string; providerId: string; country: "BR"|"MX"|"AR"; paymentMethod: "CARD"|"PIX"; issuerId: string; attempts: number; approved: number; amountUsdSum: number; approvedUsdSum: number }`
    - `type MerchantConfig = { merchantId: string; expectedConversion: number; minMaterialDropPp: number }`
    - `type RoutingCoverage = Array<{ providerId: string; country: string; paymentMethod: string }>`
  - `db/queries.ts`: `interface RollupSource { getWindowRollups(bucket: string): Promise<RollupRow[]>; getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]> }`

- [ ] **Step 1: Write the failing scaffold test**

Create `packages/app/src/detect/scaffold.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as C from "./constants";
import type { Dimension, RollupRow, SliceFilter } from "./types";
import type { RollupSource } from "../db/queries";

describe("constants", () => {
  it("match the locked values in context/detector.md §4", () => {
    expect(C.MIN_VOLUME).toBe(30);
    expect(C.Z).toBe(1.96);
    expect(C.DELTA_PP_DEFAULT).toBe(3.0);
    expect(C.PERSISTENCE_WINDOWS).toBe(3);
    expect(C.THIN_CELL_WINDOW_MIN).toBe(5);
    expect(C.ONSET_LOOKBACK_MIN).toBe(120);
    expect(C.TEMPORAL_LOOKBACK_MIN).toBe(360);
  });
});

describe("types", () => {
  it("compile with the expected shapes", () => {
    const row: RollupRow = {
      bucket: "2026-08-30T14:00:00.000Z",
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
      attempts: 100,
      approved: 95,
      amountUsdSum: 1_000_000,
      approvedUsdSum: 950_000,
    };
    const filter: SliceFilter = { merchantId: "BR_STORE_01", country: "BR" };
    const dim: Dimension = "issuerId";
    // A trivial RollupSource implementation must satisfy the interface.
    const src: RollupSource = {
      getWindowRollups: async () => [row],
      getHistory: async () => [row],
    };
    expect(filter.merchantId).toBe("BR_STORE_01");
    expect(dim).toBe("issuerId");
    expect(typeof src.getWindowRollups).toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/scaffold.test.ts`
Expected: FAIL — cannot resolve `./constants`, `./types`, `../db/queries`.

- [ ] **Step 3: Write `packages/app/src/detect/constants.ts`**

```ts
// Detector tuning. Every value is locked by a decision in context/schema.md;
// see context/detector.md §4. Do not change without a new flight log.
export const MIN_VOLUME = 30; // DD14 — min attempts per window to evaluate a cell
export const Z = 1.96; // DD11 — 95% confidence; the only parameter of the test
export const DELTA_PP_DEFAULT = 3.0; // DD14 — fallback when merchant config omits the field
export const PERSISTENCE_WINDOWS = 3; // DD11 — consecutive windows required to confirm
export const THIN_CELL_WINDOW_MIN = 5; // schema §6.3 — sliding window for thin cells
export const ONSET_LOOKBACK_MIN = 120; // schema §6.1 — retro-scan horizon for started_at
export const TEMPORAL_LOOKBACK_MIN = 360; // schema §6 — cross-temporal "last 2-6h" (we use 6h)
```

- [ ] **Step 4: Write `packages/app/src/detect/types.ts`**

```ts
// Internal detector types. RollupRow mirrors rollup_minute
// (packages/app/src/db/schema.ts). latencyP50Ms is intentionally omitted:
// detection does not use latency in this branch (context/detector.md §8 G4).

export type Dimension =
  | "merchantId"
  | "providerId"
  | "country"
  | "paymentMethod"
  | "issuerId";

export type SliceFilter = Partial<Record<Dimension, string>>;

export type RollupRow = {
  bucket: string; // ISO-8601 UTC, truncated to the minute
  merchantId: string;
  providerId: string;
  country: "BR" | "MX" | "AR";
  paymentMethod: "CARD" | "PIX";
  issuerId: string; // "NA" on PIX
  attempts: number;
  approved: number;
  amountUsdSum: number; // BIGINT in the DB; fits in 2^53 (context/rules.md §6.8)
  approvedUsdSum: number;
};

export type MerchantConfig = {
  merchantId: string;
  expectedConversion: number; // 0..1  (merchants.expected_conversion)
  minMaterialDropPp: number; // percentage points (merchants.min_material_drop_pp)
};

export type RoutingCoverage = Array<{
  providerId: string;
  country: string;
  paymentMethod: string;
}>;
```

- [ ] **Step 5: Write `packages/app/src/db/queries.ts`**

```ts
import type { RollupRow } from "../detect/types";

// Implementation (raw cube SQL over db/client.ts) lands in the SQL-layer branch.
// runDetectionTick does NOT import this: it takes arrays. This interface only
// documents the seam and the row shape the SQL must return.
export interface RollupSource {
  getWindowRollups(bucket: string): Promise<RollupRow[]>; // one bucket, all cells
  getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]>; // [from, to), all cells
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/scaffold.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/detect/constants.ts packages/app/src/detect/types.ts packages/app/src/db/queries.ts packages/app/src/detect/scaffold.test.ts
git commit -m "add: detector constants, internal types, and RollupSource seam"
```

---

## Task 4: `wilson.ts` — Wilson interval + 4-state evaluate

**Files:**
- Create: `packages/app/src/detect/wilson.ts`
- Test: `packages/app/src/detect/wilson.test.ts`

**Interfaces:**
- Consumes: `Z` from `./constants`; `CellState` (type) from `@control-tower/contracts`.
- Produces:
  - `type Interval = { low: number; high: number }`
  - `function wilson(k: number, n: number, z?: number): Interval`
  - `function evaluate(k: number, n: number, expected: number, deltaPp: number, minVolume: number): { state: CellState; ci: Interval }`

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/wilson.test.ts`. Values are hand-computed from the closed form with `z = 1.96`; assertions use `toBeCloseTo(_, 3)` (±0.0005).

```ts
import { describe, expect, it } from "vitest";
import { evaluate, wilson } from "./wilson";

describe("wilson", () => {
  it("returns the full interval when n = 0", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("clamps to [0, 1]", () => {
    const ci = wilson(0, 3);
    expect(ci.low).toBeGreaterThanOrEqual(0);
    const hi = wilson(3, 3);
    expect(hi.high).toBeLessThanOrEqual(1);
  });

  it("matches the closed form for k=2, n=5 (the sabatina example ~12%-77%)", () => {
    const ci = wilson(2, 5);
    expect(ci.low).toBeCloseTo(0.1176, 3);
    expect(ci.high).toBeCloseTo(0.7693, 3);
  });

  it("matches the closed form for k=95, n=100", () => {
    const ci = wilson(95, 100);
    expect(ci.low).toBeCloseTo(0.8882, 3);
    expect(ci.high).toBeCloseTo(0.9785, 3);
  });
});

describe("evaluate", () => {
  // expected = 0.70, deltaPp = 3  ->  p_lim = 0.67
  it("MATERIAL_DROP when the whole interval is below p_lim (k=9, n=30)", () => {
    const r = evaluate(9, 30, 0.7, 3, 30);
    expect(r.state).toBe("MATERIAL_DROP");
    expect(r.ci.high).toBeCloseTo(0.4788, 3);
  });

  it("HEALTHY when the whole interval is above p_lim (k=28, n=30)", () => {
    const r = evaluate(28, 30, 0.7, 3, 30);
    expect(r.state).toBe("HEALTHY");
    expect(r.ci.low).toBeCloseTo(0.7868, 3);
  });

  it("INSUFFICIENT_EVIDENCE when it crosses p_lim and n < minVolume (k=4, n=6)", () => {
    const r = evaluate(4, 6, 0.7, 3, 30);
    expect(r.state).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("MONITORING when it crosses p_lim and n >= minVolume (k=20, n=30)", () => {
    const r = evaluate(20, 30, 0.7, 3, 30);
    expect(r.state).toBe("MONITORING");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/wilson.test.ts`
Expected: FAIL — `./wilson` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/wilson.ts`**

```ts
import type { CellState } from "@control-tower/contracts";
import { Z } from "./constants";

export type Interval = { low: number; high: number };

// Wilson score interval for a proportion. Closed form (context/rules.md §6.6):
// no scipy, no history, no prior.
export function wilson(k: number, n: number, z: number = Z): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half =
    (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

// The whole detection test (DD11). Everything else is SQL and counting.
export function evaluate(
  k: number,
  n: number,
  expected: number,
  deltaPp: number,
  minVolume: number,
): { state: CellState; ci: Interval } {
  const limit = expected - deltaPp / 100; // p_lim
  const ci = wilson(k, n);
  if (ci.high < limit) return { state: "MATERIAL_DROP", ci };
  if (ci.low > limit) return { state: "HEALTHY", ci };
  return {
    state: n < minVolume ? "INSUFFICIENT_EVIDENCE" : "MONITORING",
    ci,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/wilson.test.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/wilson.ts packages/app/src/detect/wilson.test.ts
git commit -m "add: Wilson interval and 4-state cell evaluate (DD11)"
```

---

## Task 5: `fixtures.ts` — test builders

**Files:**
- Create: `packages/app/src/detect/fixtures.ts`
- Test: `packages/app/src/detect/fixtures.test.ts`

**Interfaces:**
- Consumes: `RollupRow`, `MerchantConfig`, `RoutingCoverage` from `./types`.
- Produces (all IDs from the Seed Data Reference — use them verbatim):
  - `const PROVIDERS = ["stripe", "adyen", "mercado_pago"] as const`
  - `const MERCHANTS_BY_COUNTRY: Record<"BR"|"MX"|"AR", string[]>` — `BR: ["BR_STORE_01","BR_STORE_02","BR_STORE_03"]`, `MX: ["MX_STORE_01","MX_STORE_02","MX_STORE_03"]`, `AR: ["AR_STORE_01","AR_STORE_02","AR_STORE_03"]`
  - `const ISSUERS_BY_COUNTRY: Record<"BR"|"MX"|"AR", string[]>` — `BR: ["itau","nubank","bradesco"]`, `MX: ["bbva_mx","banorte","citibanamex"]`, `AR: ["galicia","santander_rio","macro"]`
  - `function countryOf(merchantId: string): "BR" | "MX" | "AR"` — from the `BR_`/`MX_`/`AR_` prefix
  - `function rollupRow(overrides?: Partial<RollupRow>): RollupRow` — defaults: `bucket "2026-08-30T14:00:00.000Z"`, `merchantId "BR_STORE_01"`, `providerId "adyen"`, `country "BR"`, `paymentMethod "CARD"`, `issuerId "itau"`, `attempts 100`, `approved 95`, `amountUsdSum 1_000_000`, `approvedUsdSum 950_000`.
  - `function merchant(overrides?: Partial<MerchantConfig>): MerchantConfig` — defaults: `merchantId "BR_STORE_01"`, `expectedConversion 0.9`, `minMaterialDropPp 3.0`.
  - `function fullCoverage(): RoutingCoverage` — 12 rows: `PROVIDERS × ["BR","MX","AR"] × CARD`, plus each provider `× BR × PIX`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/fixtures.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { countryOf, fullCoverage, merchant, rollupRow } from "./fixtures";

describe("fixtures", () => {
  it("rollupRow applies defaults and overrides", () => {
    expect(rollupRow()).toMatchObject({
      merchantId: "BR_STORE_01",
      providerId: "adyen",
      country: "BR",
      paymentMethod: "CARD",
      issuerId: "itau",
      attempts: 100,
      approved: 95,
    });
    expect(rollupRow({ approved: 40, providerId: "stripe" })).toMatchObject({
      providerId: "stripe",
      approved: 40,
      attempts: 100,
    });
  });

  it("merchant applies defaults and overrides", () => {
    expect(merchant()).toEqual({
      merchantId: "BR_STORE_01",
      expectedConversion: 0.9,
      minMaterialDropPp: 3.0,
    });
    expect(merchant({ expectedConversion: 0.65 }).expectedConversion).toBe(0.65);
  });

  it("countryOf reads the merchant prefix", () => {
    expect(countryOf("MX_STORE_02")).toBe("MX");
    expect(() => countryOf("ZZ_STORE_01")).toThrow();
  });

  it("fullCoverage is the 12-row DD13 mesh", () => {
    const cov = fullCoverage();
    expect(cov).toHaveLength(12);
    expect(cov.filter((c) => c.paymentMethod === "PIX")).toHaveLength(3);
    expect(
      cov.filter((c) => c.paymentMethod === "PIX").every((c) => c.country === "BR"),
    ).toBe(true);
    expect(cov.filter((c) => c.country === "MX")).toHaveLength(3);
    expect(cov.some((c) => c.providerId === "mercado_pago")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/fixtures.test.ts`
Expected: FAIL — `./fixtures` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/fixtures.ts`**

```ts
import type { MerchantConfig, RollupRow, RoutingCoverage } from "./types";

// Real seed IDs (READ-ONLY DB, fictitious 2026-08 data). Each merchant belongs
// to exactly one country. See the plan's "Seed Data Reference".
export const PROVIDERS = ["stripe", "adyen", "mercado_pago"] as const;

export const MERCHANTS_BY_COUNTRY: Record<"BR" | "MX" | "AR", string[]> = {
  BR: ["BR_STORE_01", "BR_STORE_02", "BR_STORE_03"],
  MX: ["MX_STORE_01", "MX_STORE_02", "MX_STORE_03"],
  AR: ["AR_STORE_01", "AR_STORE_02", "AR_STORE_03"],
};

export const ISSUERS_BY_COUNTRY: Record<"BR" | "MX" | "AR", string[]> = {
  BR: ["itau", "nubank", "bradesco"],
  MX: ["bbva_mx", "banorte", "citibanamex"],
  AR: ["galicia", "santander_rio", "macro"],
};

export function countryOf(merchantId: string): "BR" | "MX" | "AR" {
  const prefix = merchantId.slice(0, 2);
  if (prefix === "BR" || prefix === "MX" || prefix === "AR") return prefix;
  throw new Error(`unknown merchant country for ${merchantId}`);
}

export function rollupRow(overrides: Partial<RollupRow> = {}): RollupRow {
  return {
    bucket: "2026-08-30T14:00:00.000Z",
    merchantId: "BR_STORE_01",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
    attempts: 100,
    approved: 95,
    amountUsdSum: 1_000_000,
    approvedUsdSum: 950_000,
    ...overrides,
  };
}

export function merchant(overrides: Partial<MerchantConfig> = {}): MerchantConfig {
  return {
    merchantId: "BR_STORE_01",
    expectedConversion: 0.9,
    minMaterialDropPp: 3.0,
    ...overrides,
  };
}

// DD13: full provider x country mesh; PIX only in BR. 12 rows (matches routing_coverage).
export function fullCoverage(): RoutingCoverage {
  const countries = ["BR", "MX", "AR"] as const;
  const rows: RoutingCoverage = [];
  for (const providerId of PROVIDERS) {
    for (const country of countries) {
      rows.push({ providerId, country, paymentMethod: "CARD" });
    }
    rows.push({ providerId, country: "BR", paymentMethod: "PIX" });
  }
  return rows;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/fixtures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/detect/fixtures.ts packages/app/src/detect/fixtures.test.ts
git commit -m "add: rollup/merchant/coverage test fixtures"
```

---

## Task 6: `aggregate.ts` — the one aggregation implementation

**Files:**
- Create: `packages/app/src/detect/aggregate.ts`
- Test: `packages/app/src/detect/aggregate.test.ts`

**Interfaces:**
- Consumes: `RollupRow`, `SliceFilter` from `./types`.
- Produces:
  - `type AggResult = { attempts: number; approved: number; amountUsdSum: number; approvedUsdSum: number; rate: number | null }` — `rate` is `null` iff `attempts === 0`.
  - `function matchesFilter(row: RollupRow, filter?: SliceFilter): boolean` — every `k=v` in `filter` equals `row[k]`; missing/empty filter matches all.
  - `function aggregate(rows: RollupRow[], opts?: { filter?: SliceFilter; exclude?: SliceFilter }): AggResult` — folds rows matching `filter` and NOT matching `exclude`.
  - `function aggregateByBucket(rows: RollupRow[], opts?: { filter?: SliceFilter }): Array<AggResult & { bucket: string }>` — one entry per distinct `bucket` present, ascending by `bucket` string.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/aggregate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregate, aggregateByBucket, matchesFilter } from "./aggregate";
import { rollupRow } from "./fixtures";

describe("matchesFilter", () => {
  it("matches all with no filter", () => {
    expect(matchesFilter(rollupRow())).toBe(true);
    expect(matchesFilter(rollupRow(), {})).toBe(true);
  });

  it("matches only when every key equals", () => {
    const r = rollupRow({ merchantId: "BR_STORE_01", providerId: "adyen" });
    expect(matchesFilter(r, { merchantId: "BR_STORE_01" })).toBe(true);
    expect(matchesFilter(r, { merchantId: "BR_STORE_01", providerId: "adyen" })).toBe(true);
    expect(matchesFilter(r, { providerId: "stripe" })).toBe(false);
  });
});

describe("aggregate", () => {
  const rows = [
    rollupRow({ providerId: "adyen", attempts: 100, approved: 30, amountUsdSum: 10, approvedUsdSum: 3 }),
    rollupRow({ providerId: "stripe", attempts: 100, approved: 90, amountUsdSum: 10, approvedUsdSum: 9 }),
    rollupRow({ providerId: "mercado_pago", attempts: 100, approved: 95, amountUsdSum: 10, approvedUsdSum: 9 }),
  ];

  it("sums everything with no opts", () => {
    expect(aggregate(rows)).toEqual({
      attempts: 300,
      approved: 215,
      amountUsdSum: 30,
      approvedUsdSum: 21,
      rate: 215 / 300,
    });
  });

  it("filters to a slice", () => {
    expect(aggregate(rows, { filter: { providerId: "adyen" } })).toMatchObject({
      attempts: 100,
      approved: 30,
      rate: 0.3,
    });
  });

  it("excludes a sub-slice (parent minus C)", () => {
    expect(
      aggregate(rows, { exclude: { providerId: "adyen" } }),
    ).toMatchObject({ attempts: 200, approved: 185, rate: 185 / 200 });
  });

  it("rate is null when attempts is 0", () => {
    expect(aggregate([], {}).rate).toBeNull();
    expect(aggregate([rollupRow({ attempts: 0, approved: 0 })]).rate).toBeNull();
  });
});

describe("aggregateByBucket", () => {
  it("groups by bucket, ascending, filtered", () => {
    const rows = [
      rollupRow({ bucket: "2026-08-30T14:02:00.000Z", providerId: "adyen", attempts: 10, approved: 5 }),
      rollupRow({ bucket: "2026-08-30T14:01:00.000Z", providerId: "adyen", attempts: 10, approved: 9 }),
      rollupRow({ bucket: "2026-08-30T14:01:00.000Z", providerId: "stripe", attempts: 10, approved: 10 }),
    ];
    const out = aggregateByBucket(rows, { filter: { providerId: "adyen" } });
    expect(out.map((b) => b.bucket)).toEqual([
      "2026-08-30T14:01:00.000Z",
      "2026-08-30T14:02:00.000Z",
    ]);
    expect(out[0]).toMatchObject({ attempts: 10, approved: 9, rate: 0.9 });
    expect(out[1]).toMatchObject({ attempts: 10, approved: 5, rate: 0.5 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/aggregate.test.ts`
Expected: FAIL — `./aggregate` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/aggregate.ts`**

```ts
import type { RollupRow, SliceFilter } from "./types";

export type AggResult = {
  attempts: number;
  approved: number;
  amountUsdSum: number;
  approvedUsdSum: number;
  rate: number | null;
};

// A row matches when every key present in `filter` equals the row's value.
// An absent or empty filter matches every row.
export function matchesFilter(row: RollupRow, filter?: SliceFilter): boolean {
  if (!filter) return true;
  for (const key of Object.keys(filter) as Array<keyof SliceFilter>) {
    if (row[key] !== filter[key]) return false;
  }
  return true;
}

function fold(rows: RollupRow[]): AggResult {
  let attempts = 0;
  let approved = 0;
  let amountUsdSum = 0;
  let approvedUsdSum = 0;
  for (const r of rows) {
    attempts += r.attempts;
    approved += r.approved;
    amountUsdSum += r.amountUsdSum;
    approvedUsdSum += r.approvedUsdSum;
  }
  return {
    attempts,
    approved,
    amountUsdSum,
    approvedUsdSum,
    rate: attempts > 0 ? approved / attempts : null,
  };
}

// The one aggregation used by expected.ts, onset-scan.ts and (later)
// diagnose/residual.ts. `exclude` is the "parent minus C" mechanism.
// Note: `exclude: {}` would match every row and fold nothing — never called that way.
export function aggregate(
  rows: RollupRow[],
  opts?: { filter?: SliceFilter; exclude?: SliceFilter },
): AggResult {
  const kept = rows.filter(
    (r) =>
      matchesFilter(r, opts?.filter) &&
      !(opts?.exclude && matchesFilter(r, opts.exclude)),
  );
  return fold(kept);
}

export function aggregateByBucket(
  rows: RollupRow[],
  opts?: { filter?: SliceFilter },
): Array<AggResult & { bucket: string }> {
  const byBucket = new Map<string, RollupRow[]>();
  for (const r of rows) {
    if (!matchesFilter(r, opts?.filter)) continue;
    const arr = byBucket.get(r.bucket);
    if (arr) arr.push(r);
    else byBucket.set(r.bucket, [r]);
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, group]) => ({ bucket, ...fold(group) }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/aggregate.ts packages/app/src/detect/aggregate.test.ts
git commit -m "add: parametrized rollup aggregation (filter/exclude/by-bucket)"
```

---

## Task 7: `expected.ts` — cross-sectional and temporal expected rate

**Files:**
- Create: `packages/app/src/detect/expected.ts`
- Test: `packages/app/src/detect/expected.test.ts`

**Interfaces:**
- Consumes: `aggregate` from `./aggregate`; `Dimension`, `RollupRow`, `SliceFilter` from `./types`.
- Produces:
  - `function crossSectionalExpected(windowRows: RollupRow[], parentFilter: SliceFilter, splitDim: Dimension, childValue: string): number | null` — rate of `aggregate(windowRows, { filter: parentFilter, exclude: { [splitDim]: childValue } })`; `null` when siblings have no volume.
  - `function temporalExpected(history: RollupRow[], sliceFilter: SliceFilter, fromBucket: string, toBucket: string): number | null` — rate of the slice over `[fromBucket, toBucket)`. Defined for future use; NOT wired into the sweep in this branch (context/detector.md §8 G7).

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/expected.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { crossSectionalExpected, temporalExpected } from "./expected";
import { rollupRow } from "./fixtures";

describe("crossSectionalExpected", () => {
  const windowRows = [
    rollupRow({ providerId: "adyen", attempts: 100, approved: 30 }),
    rollupRow({ providerId: "stripe", attempts: 100, approved: 90 }),
    rollupRow({ providerId: "mercado_pago", attempts: 100, approved: 95 }),
  ];

  it("is the siblings-minus-self rate in the same window", () => {
    const e = crossSectionalExpected(
      windowRows,
      { merchantId: "BR_STORE_01", country: "BR" },
      "providerId",
      "adyen",
    );
    expect(e).toBeCloseTo(185 / 200, 10); // (90 + 95) / (100 + 100)
  });

  it("is null when the child has no siblings with volume", () => {
    const onlyChild = [rollupRow({ providerId: "adyen", attempts: 50, approved: 10 })];
    const e = crossSectionalExpected(
      onlyChild,
      { merchantId: "BR_STORE_01", country: "BR" },
      "providerId",
      "adyen",
    );
    expect(e).toBeNull();
  });
});

describe("temporalExpected", () => {
  it("covers [from, to) and ignores rows outside it", () => {
    const history = [
      rollupRow({ bucket: "2026-08-30T13:00:00.000Z", attempts: 100, approved: 90 }),
      rollupRow({ bucket: "2026-08-30T13:30:00.000Z", attempts: 100, approved: 80 }),
      rollupRow({ bucket: "2026-08-30T14:00:00.000Z", attempts: 100, approved: 0 }), // == to, excluded
    ];
    const e = temporalExpected(
      history,
      { merchantId: "BR_STORE_01" },
      "2026-08-30T13:00:00.000Z",
      "2026-08-30T14:00:00.000Z",
    );
    expect(e).toBeCloseTo(170 / 200, 10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/expected.test.ts`
Expected: FAIL — `./expected` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/expected.ts`**

```ts
import { aggregate } from "./aggregate";
import type { Dimension, RollupRow, SliceFilter } from "./types";

// Primary (schema §6): rate of the OTHER children along splitDim, same window.
export function crossSectionalExpected(
  windowRows: RollupRow[],
  parentFilter: SliceFilter,
  splitDim: Dimension,
  childValue: string,
): number | null {
  const siblings = aggregate(windowRows, {
    filter: parentFilter,
    exclude: { [splitDim]: childValue },
  });
  return siblings.rate; // null when there are no siblings (e.g. paymentMethod in AR/MX)
}

// Secondary (schema §6): the same slice over the last window. Defined here, but
// NOT wired into crossSectionalSweep in this branch (context/detector.md §8 G7).
export function temporalExpected(
  history: RollupRow[],
  sliceFilter: SliceFilter,
  fromBucket: string,
  toBucket: string,
): number | null {
  const windowed = history.filter(
    (r) => r.bucket >= fromBucket && r.bucket < toBucket,
  );
  return aggregate(windowed, { filter: sliceFilter }).rate;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/expected.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/expected.ts packages/app/src/detect/expected.test.ts
git commit -m "add: cross-sectional and temporal expected-rate helpers"
```

---

## Task 8: `trigger.ts` — `absoluteTrigger`

**Files:**
- Create: `packages/app/src/detect/trigger.ts`
- Test: `packages/app/src/detect/trigger.test.ts` (this task adds the `absoluteTrigger` describe block; Task 9 adds `crossSectionalSweep`)

**Interfaces:**
- Consumes: `evaluate`, `Interval` from `./wilson`; `aggregate` from `./aggregate`; `MIN_VOLUME` from `./constants`; `MerchantConfig`, `RollupRow`, `SliceFilter` from `./types`.
- Produces:
  - `type Candidate = { dimensions: SliceFilter; state: "MATERIAL_DROP" | "INSUFFICIENT_EVIDENCE"; ci: Interval; observedRate: number; expectedRate: number; expectedSource: "absolute" | "cross_sectional" | "temporal"; deltaPp: number; attempts: number; approved: number; windowUsed: "1m" | "5m" }`
  - `function absoluteTrigger(windowRows: RollupRow[], merchants: MerchantConfig[]): Candidate[]` — one aggregate per distinct `(merchantId, country)`, `evaluate` against that merchant's `expectedConversion` / `minMaterialDropPp`. Emits `MATERIAL_DROP` and `INSUFFICIENT_EVIDENCE` candidates; drops `HEALTHY`/`MONITORING`. `dimensions` is always `{ merchantId, country }`. `expectedSource` is always `"absolute"`. `windowUsed` is always `"1m"`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/trigger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { absoluteTrigger } from "./trigger";
import { merchant, rollupRow } from "./fixtures";

describe("absoluteTrigger", () => {
  const merchants = [
    merchant({ merchantId: "BR_STORE_01", expectedConversion: 0.9, minMaterialDropPp: 3 }),
    merchant({ merchantId: "AR_STORE_01", expectedConversion: 0.9, minMaterialDropPp: 3 }),
  ];

  it("emits a MATERIAL_DROP candidate at merchant x country when the aggregate collapses", () => {
    // BR_STORE_01 / BR aggregate: 90 approved / 300 attempts = 0.30, p_lim = 0.87
    const rows = [
      rollupRow({ merchantId: "BR_STORE_01", country: "BR", providerId: "adyen", attempts: 100, approved: 30 }),
      rollupRow({ merchantId: "BR_STORE_01", country: "BR", providerId: "stripe", attempts: 100, approved: 30 }),
      rollupRow({ merchantId: "BR_STORE_01", country: "BR", providerId: "mercado_pago", attempts: 100, approved: 30 }),
    ];
    const out = absoluteTrigger(rows, merchants);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dimensions: { merchantId: "BR_STORE_01", country: "BR" },
      state: "MATERIAL_DROP",
      expectedSource: "absolute",
      expectedRate: 0.9,
      deltaPp: 3,
      attempts: 300,
      approved: 90,
      windowUsed: "1m",
    });
  });

  it("emits nothing when the aggregate is healthy", () => {
    const rows = [
      rollupRow({ merchantId: "BR_STORE_01", country: "BR", attempts: 300, approved: 285 }), // 0.95 > 0.87
    ];
    expect(absoluteTrigger(rows, merchants)).toEqual([]);
  });

  it("emits INSUFFICIENT_EVIDENCE when the interval crosses p_lim and n < MIN_VOLUME", () => {
    const rows = [
      rollupRow({ merchantId: "AR_STORE_01", country: "AR", issuerId: "galicia", attempts: 6, approved: 3 }),
    ];
    const out = absoluteTrigger(rows, merchants);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dimensions: { merchantId: "AR_STORE_01", country: "AR" },
      state: "INSUFFICIENT_EVIDENCE",
    });
  });

  it("only ever aggregates at merchant x country (never a cell), and skips unknown merchants", () => {
    const rows = [
      rollupRow({ merchantId: "ghost", country: "BR", attempts: 100, approved: 1 }),
    ];
    expect(absoluteTrigger(rows, merchants)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/trigger.test.ts`
Expected: FAIL — `./trigger` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/trigger.ts`**

```ts
import { aggregate } from "./aggregate";
import { MIN_VOLUME } from "./constants";
import type { MerchantConfig, RollupRow, SliceFilter } from "./types";
import { evaluate, type Interval } from "./wilson";

export type Candidate = {
  dimensions: SliceFilter;
  state: "MATERIAL_DROP" | "INSUFFICIENT_EVIDENCE";
  ci: Interval;
  observedRate: number;
  expectedRate: number;
  expectedSource: "absolute" | "cross_sectional" | "temporal";
  deltaPp: number;
  attempts: number;
  approved: number;
  windowUsed: "1m" | "5m";
};

function distinctMerchantCountry(
  rows: RollupRow[],
): Array<{ merchantId: string; country: string }> {
  const seen = new Set<string>();
  const out: Array<{ merchantId: string; country: string }> = [];
  for (const r of rows) {
    const key = `${r.merchantId}|${r.country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ merchantId: r.merchantId, country: r.country });
  }
  return out;
}

// Absolute trigger (DD17). The ONLY place expectedConversion is read, and it is
// only ever compared against the merchant x country aggregate, never a cell
// (context/schema.md §6).
export function absoluteTrigger(
  windowRows: RollupRow[],
  merchants: MerchantConfig[],
): Candidate[] {
  const byId = new Map(merchants.map((m) => [m.merchantId, m]));
  const out: Candidate[] = [];
  for (const { merchantId, country } of distinctMerchantCountry(windowRows)) {
    const m = byId.get(merchantId);
    if (!m) continue;
    const agg = aggregate(windowRows, { filter: { merchantId, country } });
    const { state, ci } = evaluate(
      agg.approved,
      agg.attempts,
      m.expectedConversion,
      m.minMaterialDropPp,
      MIN_VOLUME,
    );
    if (state !== "MATERIAL_DROP" && state !== "INSUFFICIENT_EVIDENCE") continue;
    out.push({
      dimensions: { merchantId, country },
      state,
      ci,
      observedRate: agg.rate ?? 0,
      expectedRate: m.expectedConversion,
      expectedSource: "absolute",
      deltaPp: m.minMaterialDropPp,
      attempts: agg.attempts,
      approved: agg.approved,
      windowUsed: "1m",
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/trigger.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/trigger.ts packages/app/src/detect/trigger.test.ts
git commit -m "add: absolute trigger (merchant x country vs expected_conversion, DD17)"
```

---

## Task 9: `trigger.ts` — `crossSectionalSweep`

**Files:**
- Modify: `packages/app/src/detect/trigger.ts` (add `crossSectionalSweep` and its helpers)
- Modify: `packages/app/src/detect/trigger.test.ts` (add a `crossSectionalSweep` describe block)

**Interfaces:**
- Consumes (added): `crossSectionalExpected` from `./expected`; `matchesFilter` from `./aggregate`; `Dimension`, `RoutingCoverage` from `./types`.
- Produces:
  - `function crossSectionalSweep(windowRows: RollupRow[], coverage: RoutingCoverage, merchants: MerchantConfig[]): Candidate[]`
  - Behaviour: for each distinct `(merchantId, country)` whose merchant is known, run 3 fixed splits:
    1. parent `{ merchantId, country }`, split `providerId`
    2. parent `{ merchantId, country, paymentMethod: "CARD" }`, split `issuerId`
    3. parent `{ merchantId, country }`, split `paymentMethod` — only when `country === "BR"`
  - Valid child values: distinct values of `splitDim` present under the parent in `windowRows`; for `providerId`/`paymentMethod` also intersected with `routing_coverage` for that country. If fewer than 2 valid children, skip the whole split.
  - For each child: `expected = crossSectionalExpected(...)`; if `null`, skip the child. `evaluate` with the merchant's `minMaterialDropPp` and `MIN_VOLUME`. Emit `MATERIAL_DROP` / `INSUFFICIENT_EVIDENCE` candidates; `dimensions = { ...parent, [splitDim]: value }`; `expectedSource = "cross_sectional"`; `windowUsed = "1m"`.

- [ ] **Step 1: Add the failing test block**

Append to `packages/app/src/detect/trigger.test.ts`:

```ts
import { crossSectionalSweep } from "./trigger";
import { fullCoverage } from "./fixtures";

describe("crossSectionalSweep", () => {
  const merchants = [
    merchant({ merchantId: "BR_STORE_01", expectedConversion: 0.9, minMaterialDropPp: 3 }),
    merchant({ merchantId: "MX_STORE_01", expectedConversion: 0.9, minMaterialDropPp: 3 }),
  ];

  function brCardRow(providerId: string, issuerId: string, attempts: number, approved: number) {
    return rollupRow({ merchantId: "BR_STORE_01", country: "BR", paymentMethod: "CARD", providerId, issuerId, attempts, approved });
  }

  it("isolates the provider that concentrates the deficit", () => {
    const rows = [
      // adyen collapsed across its issuers; stripe and mercado_pago healthy
      brCardRow("adyen", "itau", 40, 8),
      brCardRow("adyen", "nubank", 30, 6),
      brCardRow("adyen", "bradesco", 30, 6),
      brCardRow("stripe", "itau", 100, 95),
      brCardRow("mercado_pago", "itau", 100, 95),
    ];
    const out = crossSectionalSweep(rows, fullCoverage(), merchants);
    const providerHit = out.find(
      (c) => c.dimensions.providerId === "adyen" && !c.dimensions.issuerId,
    );
    expect(providerHit).toMatchObject({
      dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
      state: "MATERIAL_DROP",
      expectedSource: "cross_sectional",
    });
    // expected for adyen = siblings (stripe + mercado_pago) = 190/200 = 0.95
    expect(providerHit?.expectedRate).toBeCloseTo(0.95, 10);
  });

  it("skips the paymentMethod split outside BR (no siblings)", () => {
    const rows = [
      rollupRow({ merchantId: "MX_STORE_01", country: "MX", paymentMethod: "CARD", providerId: "adyen", issuerId: "bbva_mx", attempts: 100, approved: 20 }),
      rollupRow({ merchantId: "MX_STORE_01", country: "MX", paymentMethod: "CARD", providerId: "stripe", issuerId: "bbva_mx", attempts: 100, approved: 95 }),
    ];
    const out = crossSectionalSweep(rows, fullCoverage(), merchants);
    expect(out.every((c) => c.dimensions.paymentMethod === undefined || c.dimensions.providerId !== undefined)).toBe(true);
    // provider split still fires for the collapsed MX provider
    expect(out.some((c) => c.dimensions.providerId === "adyen" && c.dimensions.country === "MX")).toBe(true);
  });

  it("does not split issuer on PIX rows", () => {
    const rows = [
      rollupRow({ merchantId: "BR_STORE_01", country: "BR", paymentMethod: "PIX", providerId: "adyen", issuerId: "NA", attempts: 100, approved: 20 }),
      rollupRow({ merchantId: "BR_STORE_01", country: "BR", paymentMethod: "PIX", providerId: "stripe", issuerId: "NA", attempts: 100, approved: 95 }),
    ];
    const out = crossSectionalSweep(rows, fullCoverage(), merchants);
    expect(out.some((c) => c.dimensions.issuerId === "NA")).toBe(false);
  });

  it("ignores a provider absent from routing_coverage", () => {
    const skinny = fullCoverage().filter((c) => c.providerId !== "mercado_pago");
    const rows = [
      brCardRow("adyen", "itau", 100, 95),
      brCardRow("stripe", "itau", 100, 95),
      brCardRow("mercado_pago", "itau", 100, 5), // collapsed, but not covered -> ignored
    ];
    const out = crossSectionalSweep(rows, skinny, merchants);
    expect(out.some((c) => c.dimensions.providerId === "mercado_pago")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify the new block fails**

Run: `pnpm --filter @control-tower/app test src/detect/trigger.test.ts`
Expected: FAIL — `crossSectionalSweep` is not exported.

- [ ] **Step 3: Add `crossSectionalSweep` to `packages/app/src/detect/trigger.ts`**

Add these imports at the top (merge with the existing import block):

```ts
import { aggregate, matchesFilter } from "./aggregate";
import { crossSectionalExpected } from "./expected";
import type {
  Dimension,
  MerchantConfig,
  RollupRow,
  RoutingCoverage,
  SliceFilter,
} from "./types";
```

Append to the module:

```ts
type SplitSpec = { parent: SliceFilter; splitDim: Dimension };

function splitsFor(merchantId: string, country: string): SplitSpec[] {
  const base: SliceFilter = { merchantId, country };
  const specs: SplitSpec[] = [
    { parent: base, splitDim: "providerId" },
    { parent: { ...base, paymentMethod: "CARD" }, splitDim: "issuerId" },
  ];
  if (country === "BR") {
    specs.push({ parent: base, splitDim: "paymentMethod" }); // PIX => BR: siblings only here
  }
  return specs;
}

function validChildValues(
  windowRows: RollupRow[],
  coverage: RoutingCoverage,
  parent: SliceFilter,
  splitDim: Dimension,
): string[] {
  const present = new Set<string>();
  for (const r of windowRows) {
    if (matchesFilter(r, parent)) present.add(r[splitDim]);
  }
  // No coverage table for issuers (DD13: 3 per country, all valid).
  if (splitDim === "issuerId") return [...present];
  // provider / method: a missing routing_coverage cell is never volume-zero
  // (AGENTS.md) — it simply is not a valid sibling.
  const country = parent.country;
  const covered = new Set(
    coverage
      .filter((c) => c.country === country)
      .map((c) => (splitDim === "providerId" ? c.providerId : c.paymentMethod)),
  );
  return [...present].filter((v) => covered.has(v));
}

// Cross-sectional sweep, depth 1 (context/detector.md §5.4). Root = merchant x
// country; refines roadmap §2's "root children" wording so that
// "issuer down for a single merchant" is caught (context/spec.md §4).
export function crossSectionalSweep(
  windowRows: RollupRow[],
  coverage: RoutingCoverage,
  merchants: MerchantConfig[],
): Candidate[] {
  const byId = new Map(merchants.map((m) => [m.merchantId, m]));
  const out: Candidate[] = [];
  for (const { merchantId, country } of distinctMerchantCountry(windowRows)) {
    const m = byId.get(merchantId);
    if (!m) continue;
    for (const { parent, splitDim } of splitsFor(merchantId, country)) {
      const children = validChildValues(windowRows, coverage, parent, splitDim);
      if (children.length < 2) continue; // no siblings to compare against
      for (const value of children) {
        const childFilter: SliceFilter = { ...parent, [splitDim]: value };
        const expected = crossSectionalExpected(
          windowRows,
          parent,
          splitDim,
          value,
        );
        if (expected === null) continue; // siblings had no volume this window (§5.3)
        const childAgg = aggregate(windowRows, { filter: childFilter });
        const { state, ci } = evaluate(
          childAgg.approved,
          childAgg.attempts,
          expected,
          m.minMaterialDropPp,
          MIN_VOLUME,
        );
        if (state !== "MATERIAL_DROP" && state !== "INSUFFICIENT_EVIDENCE") {
          continue;
        }
        out.push({
          dimensions: childFilter,
          state,
          ci,
          observedRate: childAgg.rate ?? 0,
          expectedRate: expected,
          expectedSource: "cross_sectional",
          deltaPp: m.minMaterialDropPp,
          attempts: childAgg.attempts,
          approved: childAgg.approved,
          windowUsed: "1m",
        });
      }
    }
  }
  return out;
}
```

Notes:
- `r[splitDim]` is typed `string` because every `Dimension` key on `RollupRow` is string-valued (`country`/`paymentMethod` are string unions).
- `parent.country` is `string | undefined`; comparing it to `c.country` (`string`) is fine — in practice it is always set here.
- If `const childFilter: SliceFilter = { ...parent, [splitDim]: value }` trips the computed-key check under `strict`, write it as `{ ...parent, [splitDim]: value } as SliceFilter` (same shape, just silences the widened index type). The identical pattern in `expected.ts` (`exclude: { [splitDim]: childValue }`) is the precedent.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/trigger.test.ts`
Expected: PASS — both describe blocks green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/trigger.ts packages/app/src/detect/trigger.test.ts
git commit -m "add: cross-sectional sweep depth 1, root = merchant x country"
```

---

## Task 10: `persistence.ts` — 3-window counter + temporal dedup

**Files:**
- Create: `packages/app/src/detect/persistence.ts`
- Test: `packages/app/src/detect/persistence.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `./trigger`; `SliceFilter` from `./types`; `PERSISTENCE_WINDOWS` from `./constants`.
- Produces:
  - `type PersistenceEntry = { count: number; firstBucket: string; emitted: boolean }`
  - `type PersistenceState = Map<string, PersistenceEntry>` (key = fingerprint)
  - `function fingerprint(dims: SliceFilter): string` — defined keys sorted, joined `k=v` with `"|"`.
  - `function step(candidates: Candidate[], prev: PersistenceState, bucket: string): { promoted: Candidate[]; next: PersistenceState }`
  - Rules: only `MATERIAL_DROP` candidates count. `count = prev.count + 1` or `1`; `firstBucket` carried from `prev` when present. Promote when `count >= PERSISTENCE_WINDOWS && !emitted`, then set `emitted = true`. Fingerprints absent from this tick's candidates are dropped from `next` (streak reset). An already-`emitted` entry that persists stays in `next` and is not re-promoted.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/persistence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fingerprint, step, type PersistenceState } from "./persistence";
import type { Candidate } from "./trigger";

function cand(dims: Candidate["dimensions"], state: Candidate["state"] = "MATERIAL_DROP"): Candidate {
  return {
    dimensions: dims,
    state,
    ci: { low: 0.1, high: 0.3 },
    observedRate: 0.2,
    expectedRate: 0.9,
    expectedSource: "cross_sectional",
    deltaPp: 3,
    attempts: 200,
    approved: 40,
    windowUsed: "1m",
  };
}

describe("fingerprint", () => {
  it("is order-independent over the fixed keys", () => {
    expect(fingerprint({ country: "BR", merchantId: "BR_STORE_01", providerId: "adyen" })).toBe(
      fingerprint({ providerId: "adyen", merchantId: "BR_STORE_01", country: "BR" }),
    );
  });
  it("distinguishes different slices", () => {
    expect(fingerprint({ merchantId: "BR_STORE_01", country: "BR" })).not.toBe(
      fingerprint({ merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" }),
    );
  });
});

describe("step", () => {
  const dims = { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" };

  it("promotes only on the PERSISTENCE_WINDOWS-th consecutive window", () => {
    let state: PersistenceState = new Map();
    let r = step([cand(dims)], state, "t1");
    expect(r.promoted).toHaveLength(0);
    r = step([cand(dims)], r.next, "t2");
    expect(r.promoted).toHaveLength(0);
    r = step([cand(dims)], r.next, "t3");
    expect(r.promoted).toHaveLength(1);
    expect(r.next.get(fingerprint(dims))).toMatchObject({
      count: 3,
      firstBucket: "t1",
      emitted: true,
    });
  });

  it("resets the streak when a window is missed", () => {
    let r = step([cand(dims)], new Map(), "t1");
    r = step([cand(dims)], r.next, "t2");
    r = step([], r.next, "t3"); // slice recovered for one window
    expect(r.next.has(fingerprint(dims))).toBe(false);
    r = step([cand(dims)], r.next, "t4");
    expect(r.promoted).toHaveLength(0);
    expect(r.next.get(fingerprint(dims))).toMatchObject({ count: 1, firstBucket: "t4" });
  });

  it("does not re-promote an already emitted, still-dropping slice", () => {
    let r = step([cand(dims)], new Map(), "t1");
    r = step([cand(dims)], r.next, "t2");
    r = step([cand(dims)], r.next, "t3");
    expect(r.promoted).toHaveLength(1);
    r = step([cand(dims)], r.next, "t4");
    expect(r.promoted).toHaveLength(0);
    expect(r.next.get(fingerprint(dims))).toMatchObject({ count: 4, emitted: true });
  });

  it("tracks fingerprints independently", () => {
    const a = { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" };
    const b = { merchantId: "MX_STORE_02", country: "MX", issuerId: "bbva_mx" };
    let r = step([cand(a), cand(b)], new Map(), "t1");
    r = step([cand(a)], r.next, "t2"); // b misses
    expect(r.next.has(fingerprint(b))).toBe(false);
    expect(r.next.get(fingerprint(a))).toMatchObject({ count: 2 });
  });

  it("ignores non-MATERIAL_DROP candidates", () => {
    const r = step([cand(dims, "INSUFFICIENT_EVIDENCE")], new Map(), "t1");
    expect(r.promoted).toHaveLength(0);
    expect(r.next.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/persistence.test.ts`
Expected: FAIL — `./persistence` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/persistence.ts`**

```ts
import { PERSISTENCE_WINDOWS } from "./constants";
import type { Candidate } from "./trigger";
import type { SliceFilter } from "./types";

export type PersistenceEntry = {
  count: number;
  firstBucket: string;
  emitted: boolean;
};
export type PersistenceState = Map<string, PersistenceEntry>;

const KEYS: Array<keyof SliceFilter> = [
  "merchantId",
  "providerId",
  "country",
  "paymentMethod",
  "issuerId",
];

export function fingerprint(dims: SliceFilter): string {
  return KEYS.filter((k) => dims[k] !== undefined)
    .sort()
    .map((k) => `${k}=${dims[k]}`)
    .join("|");
}

// One tick of the 3-window persistence counter with temporal dedup:
// a confirmed slice is promoted exactly once, then kept ("ongoing", no
// re-alert) while it stays in MATERIAL_DROP (context/schema.md §8, roadmap §4).
export function step(
  candidates: Candidate[],
  prev: PersistenceState,
  bucket: string,
): { promoted: Candidate[]; next: PersistenceState } {
  const next: PersistenceState = new Map();
  const promoted: Candidate[] = [];
  for (const c of candidates) {
    if (c.state !== "MATERIAL_DROP") continue;
    const fp = fingerprint(c.dimensions);
    const before = prev.get(fp);
    const entry: PersistenceEntry = before
      ? { count: before.count + 1, firstBucket: before.firstBucket, emitted: before.emitted }
      : { count: 1, firstBucket: bucket, emitted: false };
    if (entry.count >= PERSISTENCE_WINDOWS && !entry.emitted) {
      entry.emitted = true;
      promoted.push(c);
    }
    next.set(fp, entry);
  }
  return { promoted, next };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/persistence.ts packages/app/src/detect/persistence.test.ts
git commit -m "add: 3-window persistence counter with emit-once temporal dedup"
```

---

## Task 11: `onset-scan.ts` — retro scan for `started_at` (DD8)

**Files:**
- Create: `packages/app/src/detect/onset-scan.ts`
- Test: `packages/app/src/detect/onset-scan.test.ts`

**Interfaces:**
- Consumes: `aggregateByBucket` from `./aggregate`; `MIN_VOLUME`, `ONSET_LOOKBACK_MIN`, `PERSISTENCE_WINDOWS` from `./constants`; `RollupRow`, `SliceFilter` from `./types`.
- Produces:
  - `function onsetScan(series: RollupRow[], sliceFilter: SliceFilter, detectionBucket: string, expectedRate: number, deltaPp: number): { startedAt: string; startedAtExact: boolean }`
  - Behaviour: aggregate `series` by bucket, filtered, restricted to `[detectionBucket - ONSET_LOOKBACK_MIN, detectionBucket]`. Walk backward from the last bucket: a bucket with `attempts >= MIN_VOLUME && rate >= pLim` breaks the run; a bucket with `attempts < MIN_VOLUME` extends the run but marks it inexact; a bucket with `attempts >= MIN_VOLUME && rate < pLim` extends it. If the run length `>= PERSISTENCE_WINDOWS`, `startedAt` is the run's first bucket. Otherwise `startedAt = detectionBucket` and `startedAtExact = false`. `startedAtExact` is also `false` if any bucket in the run was thin.
  - Assumes one entry per covered minute (`series` may include zero-attempt rows); minutes wholly absent are not reconstructed (context/detector.md §8 G8).

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/onset-scan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { onsetScan } from "./onset-scan";
import { rollupRow } from "./fixtures";

// helper: build one row per minute for a slice, given [approved, attempts] per bucket
function series(startIso: string, points: Array<[number, number]>) {
  const t0 = new Date(startIso).getTime();
  return points.map(([approved, attempts], i) =>
    rollupRow({
      bucket: new Date(t0 + i * 60_000).toISOString(),
      merchantId: "BR_STORE_01",
      country: "BR",
      providerId: "adyen",
      issuerId: "itau",
      attempts,
      approved,
    }),
  );
}

// expected 0.9, deltaPp 3 -> pLim 0.87
describe("onsetScan", () => {
  it("finds the first minute of the uninterrupted below-pLim run", () => {
    // 14:00 healthy, 14:01..14:05 collapsed (5 windows), detection at 14:05
    const rows = series("2026-08-30T14:00:00.000Z", [
      [95, 100], // 14:00  healthy -> breaks
      [30, 100], // 14:01
      [28, 100], // 14:02
      [31, 100], // 14:03
      [29, 100], // 14:04
      [30, 100], // 14:05  detection
    ]);
    const r = onsetScan(
      rows,
      { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
      "2026-08-30T14:05:00.000Z",
      0.9,
      3,
    );
    expect(r.startedAt).toBe("2026-08-30T14:01:00.000Z");
    expect(r.startedAtExact).toBe(true);
  });

  it("ignores an isolated one-minute dip (run shorter than PERSISTENCE_WINDOWS)", () => {
    const rows = series("2026-08-30T14:00:00.000Z", [
      [95, 100], // healthy
      [95, 100], // healthy
      [30, 100], // detection at 14:02, only 1 bad window
    ]);
    const r = onsetScan(
      rows,
      { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
      "2026-08-30T14:02:00.000Z",
      0.9,
      3,
    );
    expect(r.startedAt).toBe("2026-08-30T14:02:00.000Z");
    expect(r.startedAtExact).toBe(false);
  });

  it("marks the onset inexact when a window inside the run is thin", () => {
    const rows = series("2026-08-30T14:00:00.000Z", [
      [95, 100], // healthy -> breaks
      [3, 5], //   14:01 thin (attempts < MIN_VOLUME) -> extends, inexact
      [28, 100], // 14:02
      [30, 100], // 14:03
      [29, 100], // 14:04 detection
    ]);
    const r = onsetScan(
      rows,
      { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
      "2026-08-30T14:04:00.000Z",
      0.9,
      3,
    );
    expect(r.startedAt).toBe("2026-08-30T14:01:00.000Z");
    expect(r.startedAtExact).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/onset-scan.test.ts`
Expected: FAIL — `./onset-scan` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/onset-scan.ts`**

```ts
import { aggregateByBucket } from "./aggregate";
import {
  MIN_VOLUME,
  ONSET_LOOKBACK_MIN,
  PERSISTENCE_WINDOWS,
} from "./constants";
import type { RollupRow, SliceFilter } from "./types";

function minusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

// "Since when" without CUSUM (DD8): locate the onset in the aggregated data,
// do not estimate it. context/detector.md §5.7.
export function onsetScan(
  series: RollupRow[],
  sliceFilter: SliceFilter,
  detectionBucket: string,
  expectedRate: number,
  deltaPp: number,
): { startedAt: string; startedAtExact: boolean } {
  const pLim = expectedRate - deltaPp / 100;
  const from = minusMinutes(detectionBucket, ONSET_LOOKBACK_MIN);
  const buckets = aggregateByBucket(
    series.filter((r) => r.bucket >= from && r.bucket <= detectionBucket),
    { filter: sliceFilter },
  );

  let runStartIndex = -1;
  let inexact = false;
  for (let i = buckets.length - 1; i >= 0; i--) {
    const b = buckets[i]!;
    const healthy = b.attempts >= MIN_VOLUME && b.rate !== null && b.rate >= pLim;
    if (healthy) break;
    if (b.attempts < MIN_VOLUME) inexact = true;
    runStartIndex = i;
  }

  const runLen = runStartIndex >= 0 ? buckets.length - runStartIndex : 0;
  if (runStartIndex < 0 || runLen < PERSISTENCE_WINDOWS) {
    return { startedAt: detectionBucket, startedAtExact: false };
  }
  return { startedAt: buckets[runStartIndex]!.bucket, startedAtExact: !inexact };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/onset-scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @control-tower/app typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/onset-scan.ts packages/app/src/detect/onset-scan.test.ts
git commit -m "add: retro onset scan for started_at / started_at_exact (DD8)"
```

---

## Task 12: `tick.ts` — `runDetectionTick`

**Files:**
- Create: `packages/app/src/detect/tick.ts`
- Test: `packages/app/src/detect/tick.test.ts`

**Interfaces:**
- Consumes: `ConfirmedDrop`, `EvidenceGap` (types) from `@control-tower/contracts`; `absoluteTrigger`, `crossSectionalSweep`, `Candidate` from `./trigger`; `aggregate`, `matchesFilter` from `./aggregate`; `evaluate` from `./wilson`; `fingerprint`, `step`, `PersistenceState` from `./persistence`; `onsetScan` from `./onset-scan`; `MIN_VOLUME`, `THIN_CELL_WINDOW_MIN` from `./constants`; `MerchantConfig`, `RollupRow`, `RoutingCoverage` from `./types`.
- Produces:
  - `function runDetectionTick(input: { bucket: string; windowRows: RollupRow[]; history: RollupRow[]; merchants: MerchantConfig[]; coverage: RoutingCoverage; prevState: PersistenceState }): { signals: ConfirmedDrop[]; evidenceGaps: EvidenceGap[]; nextState: PersistenceState }`
  - Pure and synchronous (no `Date.now()` beyond arithmetic on the passed `bucket` string, no I/O).
  - Flow (context/detector.md §5.8):
    1. `absoluteTrigger(windowRows, merchants)`
    2. `crossSectionalSweep(windowRows, coverage, merchants)`
    3. Concatenate; dedup by `fingerprint(dimensions)`, preferring `MATERIAL_DROP` over `INSUFFICIENT_EVIDENCE` and `expectedSource "cross_sectional"` over `"absolute"`.
    4. Thin-cell retry (§5.5) on candidates whose `attempts < MIN_VOLUME`: re-aggregate the slice over the last `THIN_CELL_WINDOW_MIN - 1` history buckets + `windowRows`, re-`evaluate` against `candidate.expectedRate` / `candidate.deltaPp`. `MATERIAL_DROP` with `attempts >= MIN_VOLUME` → replace the candidate's `ci`/`observedRate`/`attempts`/`approved` and set `windowUsed = "5m"`. Otherwise the candidate becomes an `EvidenceGap` and leaves the candidate list.
    5. `step(materialDropCandidates, prevState, bucket)` → `promoted`, `nextState`.
    6. For each `promoted`: `onsetScan([...history, ...windowRows], dims, bucket, expectedRate, deltaPp)`.
    7. Assemble `ConfirmedDrop` (`ciLevel = 0.95`, `consecutiveWindows` from `nextState`, `windowBucket = bucket`) and the deduped `EvidenceGap[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/detect/tick.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfirmedDrop } from "@control-tower/contracts";
import { runDetectionTick } from "./tick";
import {
  ISSUERS_BY_COUNTRY,
  MERCHANTS_BY_COUNTRY,
  PROVIDERS,
  fullCoverage,
  merchant,
  rollupRow,
} from "./fixtures";
import type { PersistenceState } from "./persistence";
import type { RollupRow } from "./types";

const COUNTRIES = ["BR", "MX", "AR"] as const;

// Every merchant threshold pinned to 0.9 / 3pp so the tests control p_lim exactly.
const MERCHANTS = COUNTRIES.flatMap((c) =>
  MERCHANTS_BY_COUNTRY[c].map((merchantId) =>
    merchant({ merchantId, expectedConversion: 0.9, minMaterialDropPp: 3 }),
  ),
);
const COVERAGE = fullCoverage();

// One healthy window: every covered CARD cell at 95/100, every BR PIX cell at 96/100.
// A merchant belongs to exactly one country (real seed model).
function healthyWindow(bucket: string): RollupRow[] {
  const rows: RollupRow[] = [];
  for (const country of COUNTRIES) {
    for (const merchantId of MERCHANTS_BY_COUNTRY[country]) {
      for (const providerId of PROVIDERS) {
        for (const issuerId of ISSUERS_BY_COUNTRY[country]) {
          rows.push(rollupRow({ bucket, merchantId, country, providerId, issuerId, paymentMethod: "CARD", attempts: 100, approved: 95 }));
        }
        if (country === "BR") {
          rows.push(rollupRow({ bucket, merchantId, country, providerId, issuerId: "NA", paymentMethod: "PIX", attempts: 100, approved: 96 }));
        }
      }
    }
  }
  return rows;
}

// adyen CARD in BR collapses for ALL BR merchants; issuer bbva_mx collapses for
// MX_STORE_01 only.
function injectIncidents(rows: RollupRow[]): RollupRow[] {
  return rows.map((r) => {
    if (r.country === "BR" && r.providerId === "adyen" && r.paymentMethod === "CARD") {
      return { ...r, approved: 20 };
    }
    if (r.country === "MX" && r.issuerId === "bbva_mx" && r.merchantId === "MX_STORE_01") {
      return { ...r, approved: 15 };
    }
    return r;
  });
}

function bucketAt(i: number): string {
  return new Date(Date.UTC(2026, 7, 30, 14, i, 0)).toISOString();
}

describe("runDetectionTick", () => {
  it("stays silent on a healthy window", () => {
    const windows = [0, 1, 2, 3, 4, 5].map((i) => healthyWindow(bucketAt(i)));
    const r = runDetectionTick({
      bucket: bucketAt(5),
      windowRows: windows[5]!,
      history: windows.slice(0, 5).flat(),
      merchants: MERCHANTS,
      coverage: COVERAGE,
      prevState: new Map(),
    });
    expect(r.signals).toEqual([]);
    expect(r.evidenceGaps).toEqual([]);
  });

  it("emits nothing for the first two dropped windows, then confirms on the third", () => {
    // buckets 0..1 healthy, buckets 2..4 dropped
    const windows = [
      healthyWindow(bucketAt(0)),
      healthyWindow(bucketAt(1)),
      injectIncidents(healthyWindow(bucketAt(2))),
      injectIncidents(healthyWindow(bucketAt(3))),
      injectIncidents(healthyWindow(bucketAt(4))),
    ];
    let state: PersistenceState = new Map();
    let res: ReturnType<typeof runDetectionTick> | undefined;
    for (let i = 2; i <= 4; i++) {
      res = runDetectionTick({
        bucket: bucketAt(i),
        windowRows: windows[i]!,
        history: windows.slice(0, i).flat(),
        merchants: MERCHANTS,
        coverage: COVERAGE,
        prevState: state,
      });
      if (i < 4) expect(res.signals).toEqual([]);
      state = res.nextState;
    }
    const final = res!;

    // Two independent stories: adyen/BR and bbva_mx/MX_STORE_01.
    const fps = final.signals.map((s) => JSON.stringify(s.dimensions));
    expect(final.signals.length).toBeGreaterThanOrEqual(2);
    expect(fps.some((f) => f.includes('"providerId":"adyen"') && f.includes('"country":"BR"'))).toBe(true);
    expect(fps.some((f) => f.includes('"issuerId":"bbva_mx"') && f.includes('"merchantId":"MX_STORE_01"'))).toBe(true);
    // bbva_mx stayed healthy for MX_STORE_02 — never a signal there
    expect(fps.some((f) => f.includes('"issuerId":"bbva_mx"') && f.includes('"merchantId":"MX_STORE_02"'))).toBe(false);

    for (const s of final.signals) {
      expect(() => ConfirmedDrop.parse(s)).not.toThrow();
      expect(s.consecutiveWindows).toBe(3);
      expect(s.ciLevel).toBe(0.95);
      expect(s.windowBucket).toBe(bucketAt(4));
      expect(s.startedAt).toBe(bucketAt(2));
      expect(s.startedAtExact).toBe(true);
    }
  });

  it("confirms a thin candidate slice via the 5-minute window", () => {
    // The whole adyen provider slice for AR_STORE_01 is collapsed AND thin:
    // 8 attempts per issuer -> 24 for the provider slice per minute (< MIN_VOLUME),
    // but >= MIN_VOLUME once summed over 5 minutes.
    function thinWindow(bucket: string): RollupRow[] {
      return healthyWindow(bucket).map((r) =>
        r.merchantId === "AR_STORE_01" && r.country === "AR" && r.providerId === "adyen"
          ? { ...r, attempts: 8, approved: 1 }
          : r,
      );
    }
    const windows = [0, 1, 2, 3, 4, 5].map((i) => thinWindow(bucketAt(i)));
    let state: PersistenceState = new Map();
    let res: ReturnType<typeof runDetectionTick> | undefined;
    for (let i = 3; i <= 5; i++) {
      res = runDetectionTick({
        bucket: bucketAt(i),
        windowRows: windows[i]!,
        history: windows.slice(0, i).flat(),
        merchants: MERCHANTS,
        coverage: COVERAGE,
        prevState: state,
      });
      state = res.nextState;
    }
    const hit = res!.signals.find(
      (s) =>
        s.dimensions.merchantId === "AR_STORE_01" &&
        s.dimensions.country === "AR" &&
        s.dimensions.providerId === "adyen" &&
        s.dimensions.issuerId === undefined,
    );
    expect(hit).toBeDefined();
    expect(hit?.windowUsed).toBe("5m");
    expect(hit?.attempts).toBeGreaterThanOrEqual(30);
  });

  it("reports an evidence gap, never a signal, when a candidate slice is thin on every window", () => {
    // mercado_pago provider slice for AR_STORE_02: 1 attempt per issuer -> 3/min,
    // 15 over 5 minutes — never reaches MIN_VOLUME.
    function sparseWindow(bucket: string): RollupRow[] {
      return healthyWindow(bucket).map((r) =>
        r.merchantId === "AR_STORE_02" && r.country === "AR" && r.providerId === "mercado_pago"
          ? { ...r, attempts: 1, approved: 0 }
          : r,
      );
    }
    const windows = [0, 1, 2, 3, 4].map((i) => sparseWindow(bucketAt(i)));
    const res = runDetectionTick({
      bucket: bucketAt(4),
      windowRows: windows[4]!,
      history: windows.slice(0, 4).flat(),
      merchants: MERCHANTS,
      coverage: COVERAGE,
      prevState: new Map(),
    });
    expect(res.signals).toEqual([]);
    expect(
      res.evidenceGaps.some(
        (g) =>
          g.dimensions.merchantId === "AR_STORE_02" &&
          g.dimensions.providerId === "mercado_pago",
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @control-tower/app test src/detect/tick.test.ts`
Expected: FAIL — `./tick` cannot be resolved.

- [ ] **Step 3: Write `packages/app/src/detect/tick.ts`**

```ts
import type { ConfirmedDrop, EvidenceGap } from "@control-tower/contracts";
import { aggregate, matchesFilter } from "./aggregate";
import { MIN_VOLUME, THIN_CELL_WINDOW_MIN } from "./constants";
import { fingerprint, step, type PersistenceState } from "./persistence";
import { onsetScan } from "./onset-scan";
import {
  absoluteTrigger,
  crossSectionalSweep,
  type Candidate,
} from "./trigger";
import type {
  MerchantConfig,
  RollupRow,
  RoutingCoverage,
} from "./types";
import { evaluate } from "./wilson";

type TickInput = {
  bucket: string;
  windowRows: RollupRow[];
  history: RollupRow[];
  merchants: MerchantConfig[];
  coverage: RoutingCoverage;
  prevState: PersistenceState;
};

type TickOutput = {
  signals: ConfirmedDrop[];
  evidenceGaps: EvidenceGap[];
  nextState: PersistenceState;
};

function minusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

// Prefer MATERIAL_DROP over INSUFFICIENT_EVIDENCE, then cross_sectional over absolute.
function preferred(a: Candidate, b: Candidate): Candidate {
  if (a.state !== b.state) return a.state === "MATERIAL_DROP" ? a : b;
  if (a.expectedSource === b.expectedSource) return a;
  return a.expectedSource === "cross_sectional" ? a : b;
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const byFp = new Map<string, Candidate>();
  for (const c of candidates) {
    const fp = fingerprint(c.dimensions);
    const existing = byFp.get(fp);
    byFp.set(fp, existing ? preferred(existing, c) : c);
  }
  return [...byFp.values()];
}

function toGap(c: Candidate, bucket: string, attempts: number): EvidenceGap {
  return {
    dimensions: c.dimensions,
    windowBucket: bucket,
    attempts,
    reason: "INSUFFICIENT_EVIDENCE",
  };
}

// Thin-cell rule (context/detector.md §5.5): retry a low-volume candidate on the
// 5-minute sliding window, reusing the 1-minute cross-sectional expectation.
function thinCellRetry(
  c: Candidate,
  input: TickInput,
): { candidate: Candidate } | { gap: EvidenceGap } {
  const from = minusMinutes(input.bucket, THIN_CELL_WINDOW_MIN - 1);
  const rows = [
    ...input.history.filter((r) => r.bucket >= from && r.bucket < input.bucket),
    ...input.windowRows,
  ].filter((r) => matchesFilter(r, c.dimensions));
  const agg = aggregate(rows);
  const { state, ci } = evaluate(
    agg.approved,
    agg.attempts,
    c.expectedRate,
    c.deltaPp,
    MIN_VOLUME,
  );
  if (state === "MATERIAL_DROP" && agg.attempts >= MIN_VOLUME) {
    return {
      candidate: {
        ...c,
        ci,
        observedRate: agg.rate ?? 0,
        attempts: agg.attempts,
        approved: agg.approved,
        windowUsed: "5m",
      },
    };
  }
  return { gap: toGap(c, input.bucket, agg.attempts) };
}

export function runDetectionTick(input: TickInput): TickOutput {
  const raw = [
    ...absoluteTrigger(input.windowRows, input.merchants),
    ...crossSectionalSweep(input.windowRows, input.coverage, input.merchants),
  ];

  const candidates: Candidate[] = [];
  const gaps: EvidenceGap[] = [];

  for (const c of dedupe(raw)) {
    if (c.state === "INSUFFICIENT_EVIDENCE") {
      gaps.push(toGap(c, input.bucket, c.attempts));
      continue;
    }
    if (c.attempts >= MIN_VOLUME) {
      candidates.push(c);
      continue;
    }
    const retry = thinCellRetry(c, input);
    if ("candidate" in retry) candidates.push(retry.candidate);
    else gaps.push(retry.gap);
  }

  const { promoted, next } = step(candidates, input.prevState, input.bucket);

  const scanSeries = [...input.history, ...input.windowRows];

  const signals: ConfirmedDrop[] = promoted.map((c) => {
    const onset = onsetScan(
      scanSeries,
      c.dimensions,
      input.bucket,
      c.expectedRate,
      c.deltaPp,
    );
    const entry = next.get(fingerprint(c.dimensions))!;
    return {
      dimensions: c.dimensions,
      windowBucket: input.bucket,
      observedRate: c.observedRate,
      expectedRate: c.expectedRate,
      expectedSource: c.expectedSource,
      deltaPp: c.deltaPp,
      ciLow: c.ci.low,
      ciHigh: c.ci.high,
      ciLevel: 0.95,
      attempts: c.attempts,
      approved: c.approved,
      windowUsed: c.windowUsed,
      startedAt: onset.startedAt,
      startedAtExact: onset.startedAtExact,
      consecutiveWindows: entry.count,
    };
  });

  // Dedup gaps by fingerprint (a slice can be seeded from more than one path).
  const gapByFp = new Map<string, EvidenceGap>();
  for (const g of gaps) gapByFp.set(fingerprint(g.dimensions), g);

  return { signals, evidenceGaps: [...gapByFp.values()], nextState: next };
}
```

`MerchantConfig` is imported only for the `TickInput` type; `input.merchants` is passed straight through to the triggers, which do the merchant lookup. The tick never needs a merchant map of its own.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @control-tower/app test src/detect/tick.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: all packages typecheck clean; every detector test file passes.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/detect/tick.ts packages/app/src/detect/tick.test.ts
git commit -m "add: runDetectionTick composing trigger/persistence/onset-scan"
```

---

## Self-Review

**1. Spec coverage** (`context/detector.md`):

| Spec section | Task(s) |
|---|---|
| §1 scope / boundaries | Global Constraints + enforced by omission across all tasks |
| §2 module layout | Tasks 3–12 (one module per task, `trigger` split 8+9) |
| §3.1 internal types | Task 3 |
| §3.2 Zod contracts | Task 2 |
| §3.3 `RollupSource` seam | Task 3 |
| §4 constants | Task 3 |
| §5.1 `wilson` / `evaluate` | Task 4 |
| §5.2 `aggregate` / `aggregateByBucket` | Task 6 |
| §5.3 `crossSectionalExpected` / `temporalExpected` | Task 7 |
| §5.4 `absoluteTrigger` | Task 8 |
| §5.4 `crossSectionalSweep` (3 splits, coverage/PIX skips) | Task 9 |
| §5.5 thin-cell 5-minute retry | Task 12 (`thinCellRetry` in `tick.ts`, per spec "aplicada em tick.ts") |
| §5.6 `fingerprint` / `step` / dedup | Task 10 |
| §5.7 `onsetScan` | Task 11 |
| §5.8 `runDetectionTick` flow | Task 12 |
| §6 test plan (7 files) | Tasks 4, 6, 7, 8+9, 10, 11, 12 (+ `contracts.test.ts`, `scaffold.test.ts`, `fixtures.test.ts`) |
| §7 toolchain | Task 2 |
| §8 known gaps G1–G8 | Documented; G7 (temporal not wired) reflected in Task 7; G8 (no minute densify) in Task 11 |
| §9 handoff (`ConfirmedDrop` → `incidents` map) | Contract shape produced in Task 2; assembled in Task 12 |
| Docs: AGENTS.md + schema.md reconciliation | Task 1 |

No gaps.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"/"similar to Task N". Every code and test step contains the actual content. The one conditional instruction (`as SliceFilter` cast in Task 9 if the computed key trips `strict`) is explicit about condition and action.

**Seed-data alignment:** all fixtures and tests use the real seed IDs from the Seed Data Reference (`stripe`/`adyen`/`mercado_pago`; `BR_STORE_0n`/`MX_STORE_0n`/`AR_STORE_0n`; `itau`/`nubank`/`bradesco`, `bbva_mx`/`banorte`/`citibanamex`, `galicia`/`santander_rio`/`macro`; PIX issuer `NA`). Each merchant belongs to one country, so `healthyWindow` iterates country → its merchants, not a cross product.

**3. Type consistency:**
- `Candidate` shape defined in Task 8, extended-by-use (not by shape) in Task 9, consumed in Tasks 10 and 12 — same field names (`dimensions`, `state`, `ci`, `observedRate`, `expectedRate`, `expectedSource`, `deltaPp`, `attempts`, `approved`, `windowUsed`).
- `PersistenceState` / `PersistenceEntry` defined Task 10, consumed Task 12 — consistent.
- `fingerprint(dims: SliceFilter): string` — Task 10, called in Task 12 with `c.dimensions` (`SliceFilter`), consistent.
- `onsetScan(series, sliceFilter, detectionBucket, expectedRate, deltaPp)` — Task 11 signature matches the Task 12 call `onsetScan(scanSeries, c.dimensions, input.bucket, c.expectedRate, c.deltaPp)`.
- `aggregate` / `aggregateByBucket` / `matchesFilter` — Task 6 signatures match all call sites in Tasks 7, 9, 11, 12.
- `evaluate(k, n, expected, deltaPp, minVolume)` — Task 4, called identically in Tasks 8, 9, 12.
- `wilson(k, n, z?)` returns `{ low, high }`; consumers read `.ci.low` / `.ci.high` and map to `ciLow` / `ciHigh` in Task 12 — consistent.
- Contract field names (`ciLow`, `ciHigh`, `windowBucket`, `startedAtExact`, `consecutiveWindows`, `windowUsed`) identical between Task 2 schema and Task 12 assembly.
- `getHistory` (not `getSliceHistory`) used consistently in Task 3 and the spec.

No inconsistencies found.
