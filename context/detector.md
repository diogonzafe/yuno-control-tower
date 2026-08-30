---
title: "The Control Tower — Motor de detecção de queda de conversão"
doc_id: "YCT-DETECT-001"
doc_related:
  - "YCT-RULES-001"
  - "YCT-AGENTS-001"
  - "context/spec.md"
  - "context/schema.md"
  - "context/roadmap.md"
domain: "detection-engine"
dimension_schema:
  - "merchant"
  - "provider"
  - "country"
  - "payment_method"
  - "issuer"
time: "2026-08-30T05:00:00Z"
---

# The Control Tower — Motor de detecção de queda de conversão

Spec da frente F1 (`context/roadmap.md` §5, janela H+3→H+7), recortada para uma
branch: **só o detector determinístico, sem banco**. Ingestão, camada SQL do
cubo, orquestrador e agente ficam em branches seguintes. Este documento é a
referência que o plano de implementação (`writing-plans`) consome.

Vocabulário de domínio vem de `context/spec.md` §1. Código em inglês
(`context/rules.md` §2); identificadores deste spec são os nomes reais dos
módulos, funções e tipos.

---

## 1. Escopo

### 1.1 Dentro

- Os módulos puros de `packages/app/src/detect/`: intervalo de Wilson, agregação
  parametrizada, taxa esperada (corte transversal + temporal), gatilho absoluto,
  varredura transversal de profundidade 1, persistência de 3 janelas com
  deduplicação temporal, varredura retroativa do `started_at`.
- A função de composição `runDetectionTick`, que roda os módulos acima para um
  bucket de 1 minuto e devolve sinais confirmados, lacunas de evidência e o
  próximo estado de persistência.
- Os contratos Zod de saída em `packages/contracts/src/incident.ts`.
- A interface (só assinatura) `RollupSource` em `packages/app/src/db/queries.ts`.
- Toolchain mínima do pacote `app`: `tsconfig`, Vitest, scripts.
- Documentação: este spec, o flight log `flight_logs/wilson_detection.md`, o
  reparo da nota obsoleta do `AGENTS.md`.

### 1.2 Fora

| Item | Onde vive |
|---|---|
| SQL do cubo, `db/client.ts`, `docker-compose`, migrations, seeds | branch de camada SQL / F0 |
| `ingest/consumer.ts`, `ingest/rollup.ts` | branch de ingestão |
| Implementação de `RollupSource` | branch de camada SQL |
| Scheduler / tick por minuto / fiação no Fastify / SSE | branch de API |
| Escrita em `incidents`, `fingerprint` com decline dominante, ciclo de vida, memória / pgvector | `orchestrate/` |
| Custo, `priority_score`, teste residual, supressão de eco, peeling, beam search | `diagnose/` |
| Decline-mix, análise de `rollup_declines_minute` | `diagnose/decline-mix.ts` |
| Narrador, ferramentas de agente, LLM | `agent/` |
| Sinal precoce por latência | fora de escopo do projeto nesta fase |

### 1.3 Premissa herdada

`context/schema.md` DD7 / `flight_logs/fixed_expected_conversion.md`: **a taxa de
conversão é estacionária no tempo; só o volume é sazonal.** O ruído de madrugada
é coberto pelo intervalo de Wilson largo, não por baseline por hora. O detector
não tem modelo, não tem warm-up.

---

## 2. Layout de módulos

```
packages/contracts/src/
├── incident.ts        # Zod: CellState, Dimensions, ConfirmedDrop, EvidenceGap
└── index.ts           # re-exporta incident.ts (deixa de ser `export {}`)

packages/app/src/
├── detect/
│   ├── constants.ts       # MIN_VOLUME, Z, PERSISTENCE_WINDOWS, ONSET_LOOKBACK_MIN,
│   │                      #   THIN_CELL_WINDOW_MIN, TEMPORAL_LOOKBACK_MIN — cada um com ref a DD
│   ├── types.ts           # RollupRow, MerchantConfig, RoutingCoverage, SliceFilter, Dimension
│   ├── wilson.ts          # wilson() + evaluate()  (verbatim de context/rules.md §6.6)
│   ├── aggregate.ts       # aggregate() + aggregateByBucket()  — a agregação única (DRY)
│   ├── expected.ts        # crossSectionalExpected() + temporalExpected()
│   ├── trigger.ts         # absoluteTrigger() + crossSectionalSweep()
│   ├── persistence.ts     # fingerprint() + step()  — 3 janelas + dedup temporal
│   ├── onset-scan.ts      # onsetScan()  — started_at / started_at_exact (DD8)
│   └── tick.ts            # runDetectionTick()  — compõe tudo para 1 bucket
└── db/
    └── queries.ts         # interface RollupSource — SÓ assinatura, sem corpo
```

Uma responsabilidade por módulo (`context/rules.md` §1, "clean code"). `wilson.ts`
isolado com teste próprio (`context/rules.md` §6.3). `aggregate.ts` é a função
que `expected.ts`, `onset-scan.ts` e — na próxima branch — `diagnose/residual.ts`
reusam; a lógica `approved / attempts` não é reescrita em lugar nenhum.

---

## 3. Contratos de dados

### 3.1 Tipos internos do app (`packages/app/src/detect/types.ts`)

```ts
export type Dimension =
  | "merchantId" | "providerId" | "country" | "paymentMethod" | "issuerId";

export type SliceFilter = Partial<Record<Dimension, string>>;

// Espelha rollup_minute (packages/app/src/db/schema.ts §ROLLUPS).
// latencyP50Ms fica de fora: detecção não usa latência nesta branch.
export type RollupRow = {
  bucket: string;              // ISO-8601 UTC, truncado ao minuto
  merchantId: string;
  providerId: string;
  country: "BR" | "MX" | "AR";
  paymentMethod: "CARD" | "PIX";
  issuerId: string;            // "NA" em PIX
  attempts: number;
  approved: number;
  amountUsdSum: number;        // BIGINT no banco → number aqui (cabe em 2^53, ver rules.md §6.8)
  approvedUsdSum: number;
};

export type MerchantConfig = {
  merchantId: string;
  expectedConversion: number;  // 0..1  (merchants.expected_conversion)
  minMaterialDropPp: number;   // pontos percentuais (merchants.min_material_drop_pp, default 3.0)
};

export type RoutingCoverage = Array<{
  providerId: string;
  country: string;
  paymentMethod: string;
}>;
```

### 3.2 Contratos de saída (`packages/contracts/src/incident.ts`, Zod)

```ts
import { z } from "zod";

export const CellState = z.enum([
  "MATERIAL_DROP",
  "HEALTHY",
  "MONITORING",
  "INSUFFICIENT_EVIDENCE",
]);
export type CellState = z.infer<typeof CellState>;

// Uma fatia fixa um subconjunto das 5 dimensões de conversão.
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

// Sinal confirmado: MATERIAL_DROP persistente por PERSISTENCE_WINDOWS janelas.
// Emitido UMA vez por fatia (dedup temporal em persistence.ts).
export const ConfirmedDrop = z.object({
  dimensions: Dimensions,
  windowBucket: z.string().datetime(),      // bucket que fechou a 3ª janela
  observedRate: z.number(),                  // → incidents.current_rate
  expectedRate: z.number(),                  // → incidents.baseline_rate
  expectedSource: ExpectedSource,
  deltaPp: z.number(),
  ciLow: z.number(),                         // → incidents.ci_low
  ciHigh: z.number(),                        // → incidents.ci_high
  ciLevel: z.number(),                       // 0.95 → incidents.ci_level
  attempts: z.number().int(),
  approved: z.number().int(),
  windowUsed: z.enum(["1m", "5m"]),          // "5m" = passou pela regra de célula fina
  startedAt: z.string().datetime(),          // → incidents.started_at
  startedAtExact: z.boolean(),               // → incidents.started_at_exact
  consecutiveWindows: z.number().int(),      // ≥ PERSISTENCE_WINDOWS
});
export type ConfirmedDrop = z.infer<typeof ConfirmedDrop>;

// Fatia com volume insuficiente para afirmar qualquer coisa (bônus do spec §5:
// "admite que a evidência não basta"). Não é sinal, é honestidade explícita.
export const EvidenceGap = z.object({
  dimensions: Dimensions,
  windowBucket: z.string().datetime(),
  attempts: z.number().int(),
  reason: z.literal("INSUFFICIENT_EVIDENCE"),
});
export type EvidenceGap = z.infer<typeof EvidenceGap>;
```

`packages/contracts/src/index.ts` passa a ser `export * from "./incident";`.

`CellState` inclui `MONITORING` (intervalo cruza `p_lim` com `n ≥ MIN_VOLUME`)
por fidelidade a `context/schema.md` §6.3; o detector não emite nada nesse
estado, mas `evaluate()` o retorna e os testes cobrem a fronteira.

### 3.3 Seam com o banco (`packages/app/src/db/queries.ts`)

```ts
import type { RollupRow } from "../detect/types";

// Implementação (SQL cru sobre db/client.ts) → branch de camada SQL.
// runDetectionTick NÃO importa isto: recebe arrays. Esta interface só
// documenta a fronteira e o formato que o SQL terá de devolver.
export interface RollupSource {
  getWindowRollups(bucket: string): Promise<RollupRow[]>;              // 1 bucket, todas as células
  getHistory(fromBucket: string, toBucket: string): Promise<RollupRow[]>; // [from, to), todas as células
}
```

---

## 4. Constantes (`packages/app/src/detect/constants.ts`)

| Nome | Valor | Origem |
|---|---|---|
| `MIN_VOLUME` | `30` | DD14 — volume mínimo por janela para avaliar |
| `Z` | `1.96` | DD11 — 95% de confiança, único parâmetro do teste |
| `DELTA_PP_DEFAULT` | `3.0` | DD14 — usado só se `merchants.min_material_drop_pp` faltar |
| `PERSISTENCE_WINDOWS` | `3` | DD11 — janelas consecutivas para confirmar |
| `THIN_CELL_WINDOW_MIN` | `5` | schema §6.3 — janela móvel para célula fina |
| `ONSET_LOOKBACK_MIN` | `120` | schema §6.1 — horizonte da varredura retroativa |
| `TEMPORAL_LOOKBACK_MIN` | `360` | schema §6 — corte temporal "últimas 2–6h" (usamos 6h) |

`δ` efetivo é sempre `merchants.min_material_drop_pp` da fatia; a constante é só
o piso quando o catálogo não traz o campo.

---

## 5. Algoritmo

### 5.1 `wilson.ts` — Wilson + decisão de 4 estados

Segue `context/rules.md` §6.6 (com `Z` da §4 explícito no lugar do default do
parâmetro). `Interval` é local ao módulo; `CellState` vem de
`@control-tower/contracts`.

```ts
export type Interval = { low: number; high: number };

export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function evaluate(
  k: number,
  n: number,
  expected: number,
  deltaPp: number,
  minVolume: number,
): { state: CellState; ci: Interval } {
  const limit = expected - deltaPp / 100;   // p_lim
  const ci = wilson(k, n, Z);
  if (ci.high < limit) return { state: "MATERIAL_DROP", ci };
  if (ci.low > limit) return { state: "HEALTHY", ci };
  return { state: n < minVolume ? "INSUFFICIENT_EVIDENCE" : "MONITORING", ci };
}
```

### 5.2 `aggregate.ts` — a agregação única

```ts
export type AggResult = {
  attempts: number;
  approved: number;
  amountUsdSum: number;
  approvedUsdSum: number;
  rate: number | null;        // approved/attempts, ou null se attempts === 0
};

// Total sobre as linhas que casam `filter` e NÃO casam `exclude`.
// `exclude` é o mecanismo de "pai menos C" do corte transversal e do teste residual.
export function aggregate(
  rows: RollupRow[],
  opts?: { filter?: SliceFilter; exclude?: SliceFilter },
): AggResult;

// Um AggResult por bucket, ascendente por bucket. Usado por onset-scan e temporalExpected.
export function aggregateByBucket(
  rows: RollupRow[],
  opts?: { filter?: SliceFilter },
): Array<AggResult & { bucket: string }>;
```

Uma linha casa um `SliceFilter` quando todos os pares `dim=valor` batem.

### 5.3 `expected.ts` — taxa esperada da fatia

```ts
// Primário (schema §6): taxa dos OUTROS filhos ao longo de splitDim, mesma janela.
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
  return siblings.rate;   // null quando não há irmãos (ex.: paymentMethod em AR/MX)
}

// Secundário (schema §6): a mesma fatia nas últimas TEMPORAL_LOOKBACK_MIN.
// Definido nesta branch, mas NÃO ligado ao sweep (ver §8 G7).
export function temporalExpected(
  history: RollupRow[],
  sliceFilter: SliceFilter,
  fromBucket: string,
  toBucket: string,
): number | null {
  const agg = aggregate(
    history.filter((r) => r.bucket >= fromBucket && r.bucket < toBucket),
    { filter: sliceFilter },
  );
  return agg.rate;
}
```

Nesta branch o corte transversal é a **única** fonte de esperado por célula. Se
`crossSectionalExpected` devolve `null` (irmãos sem volume na janela), a fatia
não é avaliável nesta janela e o filho é pulado. `temporalExpected` fica pronto
para o dia em que o transversal falhar em produção, mas o sweep não o chama.

### 5.4 `trigger.ts` — candidatos em `MATERIAL_DROP` para uma janela

```ts
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

export function absoluteTrigger(
  windowRows: RollupRow[],
  merchants: MerchantConfig[],
): Candidate[];

export function crossSectionalSweep(
  windowRows: RollupRow[],
  coverage: RoutingCoverage,
  merchants: MerchantConfig[],
): Candidate[];
```

**`absoluteTrigger` (gatilho absoluto, DD17).** Para cada `(merchantId, country)`
distinto em `windowRows`:

1. `agg = aggregate(windowRows, { filter: { merchantId, country } })`
2. `m = merchants[merchantId]`
3. `{ state, ci } = evaluate(agg.approved, agg.attempts, m.expectedConversion, m.minMaterialDropPp, MIN_VOLUME)`
4. `MATERIAL_DROP` → `Candidate` com `expectedSource: "absolute"`, `dimensions: { merchantId, country }`.
   `INSUFFICIENT_EVIDENCE` → semente de `EvidenceGap`.

É o **único** ponto que lê `expectedConversion`, e só agrega em merchant×país —
a regra "a constante do merchant só é comparada contra o agregado do merchant,
nunca contra uma célula" (`context/schema.md` §6, `AGENTS.md`) fica garantida por
construção.

**`crossSectionalSweep` (varredura transversal, profundidade 1).** Raiz =
merchant×país (interpretação registrada em `flight_logs/wilson_detection.md`;
refina a redação "filhos da raiz" de `context/roadmap.md` §2, necessária para
cobrir o cenário obrigatório "emissor cai para um único merchant" do
`context/spec.md` §4). Para cada `(merchantId, country)` em `coverage`, três
splits fixos, coerentes com a estrutura do cubo (DD12/DD13):

| # | `parentFilter` | `splitDim` | Condição |
|---|---|---|---|
| 1 | `{ merchantId, country }` | `providerId` | sempre |
| 2 | `{ merchantId, country }` | `paymentMethod` | só se o país tem ≥ 2 métodos (só BR) |
| 3 | `{ merchantId, country, paymentMethod: "CARD" }` | `issuerId` | sempre (PIX não tem emissor) |

Para cada valor-filho `v` do split:

1. valores-filho válidos:
   - `providerId` / `paymentMethod`: distintos em `windowRows` sob `parentFilter`
     **∩** presentes em `routing_coverage` para o país.
   - `issuerId`: distintos em `windowRows` sob `parentFilter` (não há tabela de
     cobertura para emissor — DD13: 3 por país, todos válidos).
   Se houver < 2, o split inteiro é pulado (sem irmãos → nada a comparar).
2. `childAgg = aggregate(windowRows, { filter: { ...parentFilter, [splitDim]: v } })`
3. `expected = crossSectionalExpected(windowRows, parentFilter, splitDim, v)`;
   se `null`, pula `v` (§5.3 — sem fallback temporal nesta branch).
4. `evaluate(childAgg.approved, childAgg.attempts, expected, m.minMaterialDropPp, MIN_VOLUME)`
5. `MATERIAL_DROP` → `Candidate` com `dimensions: { ...parentFilter, [splitDim]: v }`
   e `expectedSource: "cross_sectional"`.
   `INSUFFICIENT_EVIDENCE` → semente de `EvidenceGap`.

Célula `providerId`/`paymentMethod` ausente de `routing_coverage` nunca é tratada
como volume zero (`AGENTS.md`): ela simplesmente não entra na lista de
valores-filho válidos.

As dimensões diagnósticas fixadas por um candidato do split 3 são
`{ merchant, country, issuer }` (o `paymentMethod: "CARD"` é estrutural, não uma
escolha de drill-down) — dentro de DD19 ("profundidade máxima 3").

### 5.5 Célula fina (`context/schema.md` §6.3, DD14)

Aplicada em `tick.ts` sobre cada `Candidate` cuja janela de 1 min tem
`attempts < MIN_VOLUME`:

1. Refazer sobre a janela móvel de `THIN_CELL_WINDOW_MIN` (5) minutos: agregar as
   linhas da mesma fatia nos `THIN_CELL_WINDOW_MIN − 1` buckets finais de
   `history` mais `windowRows` (a janela atual).
2. `evaluate` de novo. `MATERIAL_DROP` com `attempts ≥ MIN_VOLUME` → o candidato
   segue, com `windowUsed: "5m"` e `observedRate`/`ci`/`attempts`/`approved` da
   janela de 5 min.
3. Ainda `attempts < MIN_VOLUME` → o candidato vira `EvidenceGap` e sai da lista.

Não há tratamento especial de decline-mix aqui: a janela de 5–15 min para PIX de
`context/declineCodes.md` §5 é do diagnóstico, não deste detector.

### 5.6 `persistence.ts` — 3 janelas + deduplicação temporal

```ts
export type PersistenceEntry = { count: number; firstBucket: string; emitted: boolean };
export type PersistenceState = Map<string /* fingerprint */, PersistenceEntry>;

export function fingerprint(dims: SliceFilter): string;   // pares k=v ordenados, unidos por "|"

export function step(
  candidates: Candidate[],        // candidatos MATERIAL_DROP desta janela (pós célula fina)
  prev: PersistenceState,
  bucket: string,
): { promoted: Candidate[]; next: PersistenceState };
```

Regras:

- Para cada candidato: `fp = fingerprint(dims)`;
  `entry = prev.get(fp) ?? { count: 0, firstBucket: bucket, emitted: false }`;
  `entry.count += 1`.
- `entry.count ≥ PERSISTENCE_WINDOWS` **e** `!entry.emitted` → entra em `promoted`;
  `entry.emitted = true`.
- Fingerprint em `prev` ausente nos candidatos desta janela → **não** copiado para
  `next` (a série reseta; "3 janelas consecutivas").
- `entry.emitted === true` que persiste → segue em `next`, **não** re-promovido.
  É a política de dedup: "incidente contínuo não pode alertar a cada janela"
  (`context/schema.md` §8), "em curso atualiza sem re-alertar"
  (`context/roadmap.md` §4).

O detector não tem estado de "resolvido": quando a fatia recupera e some dos
candidatos, o `entry` é descartado. Reabrir depois é problema do orquestrador.

### 5.7 `onset-scan.ts` — `started_at` sem CUSUM (DD8)

```ts
export function onsetScan(
  history: RollupRow[],
  sliceFilter: SliceFilter,
  detectionBucket: string,
  expectedRate: number,       // p_e usado para a fatia
  deltaPp: number,
): { startedAt: string; startedAtExact: boolean };
```

1. `series = aggregateByBucket(history, { filter: sliceFilter })` restrito a
   `[detectionBucket − ONSET_LOOKBACK_MIN, detectionBucket]`, ascendente. Assume
   uma linha por bucket coberto (inclui minutos de zero tentativa); minutos
   totalmente ausentes de `history` não são reconstruídos.
2. `pLim = expectedRate − deltaPp / 100`.
3. Caminhar de `detectionBucket` para trás e montar a sequência contígua máxima de
   buckets "abaixo do esperado":
   - bucket com `attempts ≥ MIN_VOLUME` e `rate ≥ pLim` → **quebra** a sequência.
   - bucket com `attempts < MIN_VOLUME` (inclui 0) → **não quebra**, mas marca a
     sequência como inexata.
   - bucket com `attempts ≥ MIN_VOLUME` e `rate < pLim` → estende a sequência.
4. Sequência com comprimento `≥ PERSISTENCE_WINDOWS` → `startedAt` = bucket
   inicial dela. Caso contrário (ex.: confirmação via janela de 5 min numa célula
   fina) → `startedAt = detectionBucket`, `startedAtExact = false`.
5. `startedAtExact = false` se qualquer bucket da sequência teve `attempts < MIN_VOLUME`.

### 5.8 `tick.ts` — `runDetectionTick`

```ts
export function runDetectionTick(input: {
  bucket: string;                // bucket de 1 min que fechou (ISO UTC); todas as windowRows o compartilham
  windowRows: RollupRow[];       // todas as células desse bucket
  history: RollupRow[];          // [bucket − TEMPORAL_LOOKBACK_MIN, bucket), todas as células — NÃO inclui windowRows
  merchants: MerchantConfig[];
  coverage: RoutingCoverage;
  prevState: PersistenceState;
}): {
  signals: ConfirmedDrop[];
  evidenceGaps: EvidenceGap[];
  nextState: PersistenceState;
};
```

`detectionBucket` nos passos abaixo é `input.bucket`. Ordem:

1. `absoluteTrigger(windowRows, merchants)` → candidatos + sementes de gap.
2. `crossSectionalSweep(windowRows, coverage, merchants)` → candidatos + sementes de gap.
3. **Dedup:** concatena os candidatos dos passos 1 e 2 e remove `fingerprint`
   repetido, preferindo `MATERIAL_DROP` sobre `INSUFFICIENT_EVIDENCE` e
   `expectedSource: "cross_sectional"` sobre `"absolute"`. Nesta branch os
   fingerprints já são disjuntos por construção (absoluto fixa 2 dimensões, sweep
   fixa 3) — o passo é uma guarda, não uma transformação.
4. **Célula fina** (§5.5) sobre cada candidato; reclassifica ou converte em gap.
5. `persistence.step(candidates, prevState, bucket)` → `promoted`, `nextState`.
6. Para cada `promoted`: `onsetScan([...history, ...windowRows], dims, input.bucket, expectedRate, deltaPp)`
   (o bucket de detecção precisa estar na série).
7. Montar `ConfirmedDrop` (com `ciLevel = 0.95`, `consecutiveWindows = entry.count`,
   `baselineRate`/`currentRate` da janela que promoveu) e a lista final de
   `EvidenceGap` (dedup por `fingerprint`). Retornar.

Função **pura e síncrona**: sem `Date.now()`, sem I/O. Quem chama fornece os
arrays e persiste `nextState`.

---

## 6. Plano de testes (ordem TDD — `context/rules.md` §4)

Red-green-refactor, teste antes do código, tudo determinístico, fixtures
calculadas à mão, sem mock de tempo, sem LLM.

| # | Arquivo | Cobre |
|---|---|---|
| 1 | `wilson.test.ts` | `wilson()`: `n = 0 → {0, 1}`; valores fechados para alguns `(k, n)`; `low ≥ 0`, `high ≤ 1`. `evaluate()`: tabela dos 4 estados, linhas exatas na fronteira `p_lim` (`ci.high` logo abaixo / logo acima; cruzando com `n = 29` e `n = 30`). |
| 2 | `aggregate.test.ts` | Lotes fixos de `RollupRow[]` → somas exatas de `attempts`/`approved`/`amountUsdSum`/`approvedUsdSum`; `rate` nulo com `attempts = 0`; `filter` por subconjunto; `exclude` (pai menos C); `aggregateByBucket` ordenado e por bucket. |
| 3 | `expected.test.ts` | `crossSectionalExpected`: taxa dos irmãos menos si; `null` sem irmãos. `temporalExpected`: mesma fatia sobre N buckets; respeito às bordas `[from, to)`. |
| 4 | `trigger.test.ts` | `absoluteTrigger`: fronteira merchant×país (dentro / fora / cruzando); lê só `expectedConversion`; nunca agrega abaixo de merchant×país. `crossSectionalSweep`: isola o filho que concentra o déficit; pula split com < 2 filhos válidos; célula fora de `routing_coverage` ignorada; sem split de `issuerId` em PIX; `paymentMethod` só em BR. |
| 5 | `persistence.test.ts` | 2 janelas não promove; 3ª promove com `consecutiveWindows = 3`; sequência interrompida reseta; contadores independentes por `fingerprint`; `firstBucket` preservado; fatia já `emitted` que persiste não re-promove. |
| 6 | `onset-scan.test.ts` | Acha o 1º bucket da sequência ininterrupta abaixo de `p_lim`; exige ≥ 3 consecutivos (soluço isolado ignorado); bucket de baixo volume dentro da sequência → `startedAtExact = false`; sequência curta → `startedAt = detectionBucket`, inexato. |
| 7 | `tick.test.ts` | **Operação normal** (~30 buckets saudáveis) → `signals: []`. **Cenário obrigatório** (`context/spec.md` §4): provider recusando só no BR **e** emissor caindo para um único merchant no MX, simultâneos em ≥ 3 buckets → **dois** `ConfirmedDrop` distintos, com `dimensions` / `startedAt` / `expectedSource` corretos (não se testa ordenação nem merge — é diagnóstico). **Persistência**: mesmo drop nos buckets 1–2 sem sinal, bucket 3 emite. **Célula fina**: `< 30` em 1 min e `≥ 30` em 5 min → confirma com `windowUsed: "5m"`. **Evidência insuficiente**: `< 30` nos dois → `evidenceGaps`, nunca `signals`. |

Runner: **Vitest** (`context/rules.md` §6.1 — "só em Wilson e no teste residual"
lá é sobre *o que* merece teste; aqui o núcleo inteiro é determinístico e barato,
então todos os 7 arquivos rodam no mesmo Vitest).

---

## 7. Toolchain

Nenhuma dependência de produção nova — Wilson é fórmula fechada
(`context/rules.md` §6.1).

| Arquivo | Mudança |
|---|---|
| `tsconfig.base.json` (raiz) | novo — `strict`, ESM, `module`/`moduleResolution` `NodeNext`, `target` ES2022 |
| `packages/app/tsconfig.json` | novo — estende a base, `types: ["node"]` |
| `packages/contracts/tsconfig.json` | novo — estende a base |
| `packages/app/package.json` | + dep `"@control-tower/contracts": "workspace:*"`; + devDeps `vitest`, `@types/node`; + scripts `test`, `test:watch`, `typecheck` |
| `packages/contracts/package.json` | + script `typecheck` |
| `packages/app/vitest.config.ts` | novo — `environment: "node"`, `include: ["src/**/*.test.ts"]` |
| `package.json` (raiz) | + scripts `test` (`pnpm -r test`), `typecheck` (`pnpm -r typecheck`) |
| `pnpm-lock.yaml` | regenerado (devDeps novas) |

---

## 8. Decisões e lacunas conhecidas

Registradas aqui para não serem "descobertas" na sabatina; a defesa é o flight
log `flight_logs/wilson_detection.md`.

| # | Lacuna | Consequência / mitigação |
|---|---|---|
| G1 | Sem teste residual / supressão de eco nesta branch | Um mesmo problema pode gerar `{merchant, country}` (absoluto) **e** `{merchant, country, +dim}` (transversal). O orquestrador + `diagnose/residual.ts` colapsam sombras depois. O contrato `ConfirmedDrop` já carrega tudo que o teste residual precisa. |
| G2 | Raiz da varredura = merchant×país, não "filhos da raiz" | Diverge da letra de `context/roadmap.md` §2. Necessário para o cenário obrigatório do `context/spec.md` §4. Registrado no flight log; ponteiro adicionado em `context/schema.md` §6. |
| G3 | `TEMPORAL_LOOKBACK_MIN` fixo em 360 | Sem parâmetro por merchant (YAGNI, `context/rules.md` §1). |
| G4 | `latency_p50_ms` fora do `RollupRow` | Sem sinal precoce por latência. É "cortável" já em `context/schema.md` §2. |
| G5 | `RollupSource` sem implementação | O detector não roda contra banco vivo até a branch de camada SQL. Testado 100% com fixtures em memória. |
| G6 | `MONITORING` nunca vira sinal | Estado existe em `evaluate()` e nos testes por fidelidade a `context/schema.md` §6.3, mas o detector só age em `MATERIAL_DROP` persistente. |
| G7 | `temporalExpected` definido mas não ligado ao sweep | O corte transversal é a única fonte de esperado por célula nesta branch. Se ele falha (`null`), o filho é pulado. O fallback temporal fica para quando o transversal se mostrar insuficiente em produção. |
| G8 | Onset-scan não densifica o eixo de minutos | Opera sobre os buckets presentes em `history`; minutos sem nenhuma linha não são reconstruídos. Aceitável para o gerador (rollup só grava célula com atividade); refinar quando a fonte real de rollup estiver definida. |

---

## 9. Handoff — o que sai do detector

`runDetectionTick` devolve, por bucket:

- **`signals: ConfirmedDrop[]`** — o orquestrador (branch futura) mapeia cada um
  para uma linha de `incidents`:

  | Campo do `ConfirmedDrop` | Coluna de `incidents` |
  |---|---|
  | `dimensions` | `dimensions` (+ base do `fingerprint`) |
  | `observedRate` | `current_rate` |
  | `expectedRate` | `baseline_rate` |
  | `ciLow` / `ciHigh` / `ciLevel` | `ci_low` / `ci_high` / `ci_level` |
  | `startedAt` / `startedAtExact` | `started_at` / `started_at_exact` |
  | `windowBucket` | base de `detected_at` |

  `lost_approvals`, `cost_*`, `priority_score`, `evidence`, `narrative_*`,
  `playbook_id`, `embedding` não são preenchidos pelo detector. A divisão,
  fechada em `flight_logs/who_assembles_the_evidence_object.md`:

  | Coluna | Quem preenche |
  |---|---|
  | `lost_approvals`, `cost_*`, `priority_score` | `diagnose/` (`cost.ts`) |
  | `evidence` | **`diagnose/evidence.ts`**, determinístico — o `ConfirmedDrop` acima entra nele como a parte "o que caiu". O agente nunca monta o objeto; só contribui a trilha opcional |
  | `narrative_*` | `agent/narrator.ts`, a partir do `EvidenceObject` fechado |
  | `playbook_id` | motor de playbooks |
  | `embedding`, `fingerprint`, ciclo de vida | `orchestrate/` |

- **`evidenceGaps: EvidenceGap[]`** — a UI mostra como o bônus "o sistema admite
  que não sabe" (`context/spec.md` §5).

- **`nextState: PersistenceState`** — quem chama persiste (memória do processo ou
  tabela) e devolve no próximo tick.
