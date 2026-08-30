---
title: "The Control Tower — Regras de engenharia"
doc_id: "YCT-RULES-001"
doc_related:
  - "YCT-AGENTS-001"
  - "context/spec.md"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/README.md"
domain: "engineering-governance"
dimension_schema: []
time: "2026-08-30T05:00:00Z"
---

# The Control Tower — Regras de engenharia

Como o time escreve código neste projeto. Não repete o que já está em `spec.md`, `schema.md` e `roadmap.md` — assume que quem lê isto já leu aqueles.

---

## 1. Os quatro princípios, aplicados a este projeto

**DRY.** As três leituras do rollup (`query_slice`, teste residual, varredura retroativa) usam a mesma função de agregação com parâmetros diferentes — não três implementações. Se a lógica de conversão (`approved / attempts`) aparece em mais de um lugar, é bug esperando acontecer: os dois lugares vão divergir na primeira mudança de regra (ex.: DD11, intervalo de Wilson).

**YAGNI.** O escopo já está travado nas decisões DD1–DD11 e nas pendências P1–P4. Não implementar:
- baseline sazonal aprendido (matado por DD7)
- CUSUM ou detector de ponto de mudança (matado por DD8)
- retry ou estado `PENDING` (matado por DD1/DD2)
- suporte a dimensões ou países fora dos travados em DD4/DD5/DD6

Se uma pendência aberta (P1–P4) ainda não foi decidida no kickoff, não implementar a versão genérica "pra qualquer cenário futuro" — implementar a decisão travada e documentar a lacuna no decision log.

**Clean code.** Nomes de função batem com o vocabulário do glossário (`spec.md` §1): `expected_conversion`, `decline_family`, `residual_test`, não sinônimos inventados. Uma função por responsabilidade das três naturezas do §1 do roadmap — determinístico, agêntico, LLM — nunca misturadas no mesmo arquivo. Se uma função de narrador contém uma conta, é code smell: o cálculo vazou pro lugar errado.

**TDD.** Red-green-refactor, nessa ordem, sempre. Teste antes do código, não depois. Ver §3.

---

## 2. Idioma e comentários no código

**Código sempre em inglês, sem exceção.** Nomes de variável, parâmetro, função, classe, arquivo, tabela, coluna, branch, commit e mensagem de erro — tudo em inglês, padrão de mercado. Nenhuma variável em português, nem como atalho temporário: `expectedConversion`, não `conversaoEsperada`; `declineFamily`, não `familiaDeRecusa`; `attempts`/`approved`, não `tentativas`/`aprovadas`. Os documentos de contexto (`spec.md`, `roadmap.md`, `schema.md`, este arquivo) ficam em português porque são pra o time; o código fica em inglês porque é o artefato técnico e vai pro repositório público (`spec.md` §6 exige README público). Não misturar: nada de `calculaConversao` ao lado de `computeCost` no mesmo módulo.

**Comentário só quando o código sozinho não explica o porquê.** Comentário não descreve o que a linha faz — isso o nome da função e da variável já fazem. Comentário existe pra registrar a razão de uma decisão não óbvia: por que um limiar tem aquele valor exato, por que uma abordagem óbvia foi descartada, uma referência a uma decisão travada (`DD8`, `DD11`) que explica por que o código não faz algo que pareceria natural fazer.

```
// ruim — descreve o óbvio
// increment attempts by 1
attempts += 1

// bom — registra o porquê, referencia a decisão travada
// Optimistic edge of the Wilson interval, not the point estimate,
// so the cost figure is a floor, never an inflated guess (see DD11).
const affectedCost = optimisticDeclineRate * ticketAverage;
```

Sem docstring de parágrafo, sem bloco de comentário decorativo (`// ======`), sem comentário que vira obsoleto porque descreve comportamento em vez de motivo. Se o comentário some e ninguém fica confuso, ele não devia existir.

### 2.1 Cabeçalho obrigatório de documentação Markdown

Todo arquivo `.md` criado no repositório começa com YAML front matter, antes do
primeiro título, delimitado por `---` — exceto os de `flight_logs/` (ver §7.2).
Os seis campos são obrigatórios e não podem ser duplicados:

```yaml
---
title: "Título humano e específico"
doc_id: "YCT-AREA-001"
doc_related: []
domain: "domain-slug"
dimension_schema: []
time: "2026-08-29T22:47:03Z"
---
```

| Campo | Contrato |
|---|---|
| `title` | Título legível, específico e coerente com o primeiro `#` do documento. |
| `doc_id` | ID estável e único no formato `YCT-<AREA>-<NNN>`. Nunca renomear nem reutilizar. |
| `doc_related` | Lista YAML de `doc_id` relacionados. Para legado sem ID, usar temporariamente o caminho relativo. Usar `[]` sem relações. |
| `domain` | Slug em inglês do domínio primário do documento. |
| `dimension_schema` | Lista com apenas `merchant`, `provider`, `country`, `payment_method`, `issuer` e/ou `decline_code`. Usar `[]` quando não se aplicar. |
| `time` | Última alteração substantiva em UTC/RFC 3339 (`YYYY-MM-DDTHH:mm:ssZ`). Não atualizar em mudança só de formatação. |

Antes de criar o arquivo, buscar `doc_id:` no repositório e reservar o próximo ID
livre da área. Antes de concluir, validar o YAML, os seis campos, o UTC e a
unicidade do `doc_id`.

---

## 3. As três fronteiras que não podem vazar

Isso vem direto do roadmap §1 e é a regra mais importante deste documento:

1. **O agente nunca vê transação crua.** Toda ferramenta exposta a ele devolve métrica já agregada (`rollup_minute` / `rollup_declines_minute`), nunca uma linha de `transactions`. Se uma tool nova retorna algo que se parece com uma transação individual, ela está errada por definição.
2. **O narrador nunca calcula.** Recebe um objeto de evidência fechado (já contém todos os números) e só produz texto. Nenhum `+`, `-`, `*`, `/` no código do narrador. Se um número aparece na narrativa que não veio literalmente de um campo do objeto de evidência, é alucinação por construção — e o teste que pega isso é obrigatório (§4).
3. **Todo caminho agêntico tem fallback determinístico.** Nenhuma feature que passa pelo agente pode ser a única forma de chegar ao diagnóstico. Se o agente não existisse, o beam search da F2 ainda produz o mesmo resultado, só sem a trilha de investigação.

Consequência direta da #3, fechada em `flight_logs/quem_monta_o_evidence_object.md`: **quem monta o `EvidenceObject` é `diagnose/evidence.ts`, deterministicamente — nunca o agente.** Se o agente montasse, o fallback precisaria de uma segunda implementação do mesmo objeto. O agente só contribui a trilha opcional; `orchestrate/` persiste o objeto pronto sem inspecioná-lo; o narrador o consome fechado (fronteira #2).

Code review rejeita qualquer PR que viole uma destas três, independente de passar nos testes.

---

## 4. TDD, como se aplica em cada camada

| Camada | O que testar primeiro | Formato do teste |
|---|---|---|
| Rollups / ingestão | Dado um lote de eventos, o agregado bate exatamente | Teste de unidade determinístico, sem mocks de tempo |
| Gatilho absoluto + corte transversal | Limiar exato do intervalo de Wilson nas bordas (dentro / fora / empatado) | Casos de tabela, valores fixos, sem aleatoriedade |
| Teste residual | Cenário sintético com uma célula causal conhecida + N ecos → resíduo limpa pros ecos, não pra causal | Fixture com números calculados à mão, não gerados |
| Beam search / diagnóstico | Cenário do briefing (provider BR + emissor MX simultâneos) reproduzido como fixture fixa | Teste de integração sobre `rollup_minute` semeado |
| Ferramentas do agente | Cada tool testada isolada: input → output determinístico, sem chamar LLM | Teste de unidade, LLM sempre mockado aqui |
| Narrador | Dado o mesmo objeto de evidência, o texto gerado não contém nenhum número ausente do objeto | Teste que faz parsing de números no output e confere contra o objeto de evidência — este teste é o que garante a fronteira #2 |
| Agente end-to-end | Só depois que as tools individuais têm cobertura; usa LLM real ou gravado (cassette), não mockado camada por camada | Teste de integração, roda separado do resto (mais lento) |

Regra prática: se não dá pra escrever o teste antes porque "ainda não sei que forma a resposta vai ter", é sinal de que o design não está pronto — voltar pro contrato de dados antes de escrever implementação.

**Sempre determinístico primeiro.** Testes que dependem de LLM (o narrador, o agente end-to-end) vêm depois de todo o resto ter cobertura, porque são os mais lentos e os mais frágeis. Nunca são o único teste de uma regra de negócio — a regra em si (ex.: o limiar de Wilson) tem que ter teste que não toca LLM nenhum.

---

## 5. Checklist de PR

Antes de abrir PR, confirmar:

- [ ] Testes escritos antes do código (não adicionados depois pra cobrir o que já existe)
- [ ] Nenhuma das três fronteiras da §3 violada
- [ ] Nenhuma variável, função ou identificador em português
- [ ] Nenhuma feature das listadas como YAGNI na §1 foi implementada "por precaução"
- [ ] Lógica de agregação não duplicada entre rollup, teste residual e varredura retroativa
- [ ] Se toca em decisão travada (DD1–DD11), o PR não a contradiz sem discussão prévia registrada
- [ ] Se toca em pendência aberta (P1–P4) ainda não resolvida, a lacuna está anotada, não resolvida por suposição
- [ ] Toda decisão importante tomada no PR tem flight log em `flight_logs/` e linha no índice (ver §7)
- [ ] Todo `.md` novo — exceto os de `flight_logs/` — possui front matter válido com `title`, `doc_id`, `doc_related`, `domain`, `dimension_schema` e `time`
- [ ] Cada `doc_id` novo é único e cada `time` alterado representa mudança substantiva em UTC/RFC 3339

---

## 6. Stack (Node / TypeScript)

Fecha as decisões de tecnologia para o prazo de 24 horas. Substitui a estrutura de repositório em Python do documento anterior.

### 6.0 Por que TS inteiro agora fecha

A recomendação original era Python para o motor, por causa do scipy. **DD11 eliminou esse argumento.** O intervalo de Wilson é fórmula fechada; o resto do sistema é contagem, `GROUP BY` e comparação. Não sobrou nenhuma operação numérica que justifique um segundo runtime.

Um runtime só significa: um `package.json`, tipos compartilhados de ponta a ponta entre o gerador e a UI, e nenhuma serialização entre linguagens às três da manhã. Em 24 horas isso vale mais que qualquer biblioteca.

**Onde Node seria pior:** se o projeto precisasse de regressão, decomposição sazonal ou qualquer coisa de `statsmodels`. Não precisa. Vale ter essa resposta pronta, porque um juiz pode perguntar por que não Python.

### 6.1 Escolhas, em uma tabela

| Camada | Escolha | Por quê, e o que foi descartado |
|---|---|---|
| Runtime | **Node 22 LTS** + TypeScript strict, ESM | — |
| Monorepo | **pnpm workspaces** | Tipos compartilhados sem publicar pacote. Turborepo é overhead para 4 pacotes |
| Contratos | **Zod** | Uma definição vira validação em runtime *e* tipo TS. É o "contrato congelado" da H+0 |
| API | **Fastify** | SSE trivial, validação por schema nativa, TS de primeira classe. Express é mais lento e sem tipos; Nest é peso morto em 24h |
| Banco | **Postgres 16 + pgvector** | DD15 |
| Driver | **postgres.js** (`postgres`), sob o Drizzle | Continua sendo o driver. As queries do cubo são SQL cru via `db.execute(sql\`…\`)` — Drizzle não é usado como query builder ali |
| Schema + migrations | **Drizzle** (`drizzle-orm` + `drizzle-kit`) sobre postgres.js | `push` durante a fase de fundações, `generate` quando congela. Resolve o `BIGINT` como string de graça. Ver §6.3.1 |
| Stream | **Redis 7 + Redis Streams** via `ioredis` | Consumer groups e replay reais. **BullMQ é a ferramenta errada aqui**: é fila de job, não stream de eventos |
| Estatística | **Nenhuma biblioteca** | Wilson é 8 linhas. `simple-statistics` se precisarem de algo mais |
| Agente | **Mastra** | Ver §6.4 e `flight_logs/ai_agent_module.md` |
| LLM | **`openai`** SDK com function calling | **GPT-5.6 Sol** no investigador, **GPT-5.6 Terra** no narrador. Ver §6.4.1 |
| Front | **Vite + React 19 + TypeScript** | Boot instantâneo, zero surpresa de build. Next é possível, mas SSR não serve para nada aqui |
| Estado no front | **TanStack Query** + `EventSource` nativo | SSE não precisa de biblioteca |
| Gráficos | **Recharts** | Barra de erro pronta, que é exatamente o visual do Wilson |
| Estilo | **Tailwind + shadcn/ui** | Polimento visual de graça |
| Logs | **pino** | — |
| Testes | **Vitest**, só em Wilson e no teste residual | Nada mais é testado em 24h. Esses dois, sim |

### 6.2 Processos

Três, não cinco. Cada processo a mais é uma coisa a mais que pode estar caída na hora da demo.

```
┌─ generator ──┐   escreve no Redis Stream
│  tsx watch   │   ~60 TPS · API de injeção
└──────────────┘
┌─ app ────────┐   consome o stream, roda rollup + detector +
│  Fastify     │   orquestrador + agente, e serve REST/SSE
└──────────────┘
┌─ web ────────┐   Vite dev server
└──────────────┘
```

Motor e API no mesmo processo é deliberado: o detector precisa empurrar evento para o SSE no instante em que confirma, e no mesmo processo isso é uma chamada de função em vez de mais um canal Redis.

**Consequência a declarar:** não escala horizontalmente assim. A resposta de sabatina é que o consumo é por consumer group e o detector é stateless por célula, então separar é mudança de deploy, não de arquitetura.

### 6.3 Estrutura do repositório

```
control-tower/
├── docker-compose.yml            # postgres+pgvector, redis
├── pnpm-workspace.yaml
├── .env.example
├── README.md                     # arquitetura + como rodar + decision log
│
├── drizzle.config.ts
├── drizzle/                      # migrations geradas (versionadas)
│   └── 0000_extensions.sql       # CREATE EXTENSION vector — manual, roda primeiro
│
├── db/
│   └── seeds/
│       ├── merchants.csv
│       ├── providers.csv
│       ├── issuers.csv
│       ├── decline_codes.csv     # do catálogo de decline codes
│       ├── routing_coverage.csv  # 12 linhas (DD13)
│       └── fx_rates.csv
│
├── packages/
│   ├── contracts/                # ⚠️ congelado na H+0
│   │   └── src/
│   │       ├── transaction.ts    # Zod: evento de transação
│   │       ├── incident.ts       # Zod: EvidenceObject, estados
│   │       ├── injection.ts      # Zod: comando do console do júri
│   │       └── index.ts
│   │
│   ├── generator/
│   │   └── src/
│   │       ├── volume.ts         # DD7: só o volume é sazonal
│   │       ├── mix.ts            # mistura basal de decline codes
│   │       ├── incident.ts       # assinaturas de incidente
│   │       ├── emit.ts           # XADD no Redis Stream
│   │       └── inject-api.ts     # HTTP para o console do júri
│   │
│   ├── app/
│   │   └── src/
│   │       ├── ingest/
│   │       │   ├── consumer.ts       # consumer group
│   │       │   └── rollup.ts         # upsert nos dois rollups
│   │       ├── detect/
│   │       │   ├── wilson.ts         # ⭐ 8 linhas, com teste
│   │       │   ├── expected.ts       # constante + corte transversal
│   │       │   ├── trigger.ts        # merchant × país (DD17)
│   │       │   ├── persistence.ts    # 3 janelas
│   │       │   └── onset-scan.ts     # DD8: "desde quando"
│   │       ├── diagnose/
│   │       │   ├── beam-search.ts    # profundidade 3 (DD19)
│   │       │   ├── residual.ts       # ⭐ teste residual, com teste
│   │       │   ├── peeling.ts        # DD18: incidentes simultâneos
│   │       │   ├── parsimony.ts      # desempate
│   │       │   ├── decline-mix.ts    # deslocamento da mistura
│   │       │   ├── cost.ts           # ponta conservadora do intervalo
│   │       │   └── evidence.ts       # ⭐ monta o EvidenceObject (determinístico)
│   │       ├── orchestrate/
│   │       │   ├── fingerprint.ts
│   │       │   ├── lifecycle.ts      # open->monitoring->resolved->inconclusive
│   │       │   └── memory.ts         # exato + pgvector
│   │       ├── agent/
│   │       │   ├── tools.ts          # 6 ferramentas sobre diagnose/
│   │       │   ├── investigator.ts   # budget 12 passos, timeout
│   │       │   ├── fallback.ts       # cai no beam-search
│   │       │   └── narrator.ts       # ops + exec, com template reserva
│   │       ├── api/
│   │       │   ├── routes.ts
│   │       │   └── sse.ts
│   │       └── db/
│   │           ├── client.ts
│   │           └── queries.ts        # SQL do cubo, em um lugar só
│   │
│   └── web/
│       └── src/
│           ├── components/
│           │   ├── ConversionChart.tsx
│           │   ├── IncidentFeed.tsx
│           │   ├── EvidencePanel.tsx     # ⭐ prova o RF3
│           │   ├── WilsonBar.tsx         # ⭐ intervalo + esperado
│           │   └── InjectConsole.tsx     # ⭐ o júri usa isto
│           └── hooks/useEventStream.ts
│
└── harness/
    └── run.ts                    # 30 incidentes, mede acerto (DD20)
```

Os cinco itens marcados com ⭐ são os que ganham pontos. Se algo for cortado, não é nenhum deles.

#### 6.3.1 Drizzle: onde entra e onde não entra

**Drizzle não substitui o SQL do cubo.** A busca monta `GROUP BY` dinâmico a cada passo, e query builder tipado atrapalha nisso. A divisão é:

| Trabalho | Ferramenta |
|---|---|
| Definição de schema e migrations | Drizzle schema em TS + `drizzle-kit` |
| Insert de transação, upsert de rollup, CRUD de incidente | Drizzle tipado |
| Queries do cubo: corte transversal, teste residual, peeling, varredura retroativa | **SQL cru** via `db.execute(sql\`…\`)` |

**Por que Drizzle e não `.sql` na mão**

**O `push`.** Entre H+0 e H+3 o schema ainda está se mexendo. `drizzle-kit push` sincroniza o banco direto a partir do TS, sem gerar arquivo de migration. Editar uma coluna e rodar um comando, sem escrever DDL nem numerar arquivo. Quando o contrato congela, um `drizzle-kit generate` produz a pasta de migrations de verdade para o repo público.

**Resolve o `BIGINT` como string.** Era um risco listado no §6.8. `bigint({ mode: 'number' })` devolve `number` em vez de string, e centavos cabem folgado em 2^53. O bug de concatenar dinheiro silenciosamente deixa de existir.

**Uma fonte de verdade em TS**, no mesmo repositório e na mesma linguagem dos schemas Zod do pacote `contracts`.

**Esqueleto do schema**

```ts
import { pgTable, pgEnum, text, integer, bigint, numeric, timestamp,
         date, jsonb, uuid, boolean, primaryKey, index, vector } from 'drizzle-orm/pg-core';

export const country = pgEnum('country', ['BR', 'MX', 'AR']);
export const method  = pgEnum('payment_method', ['CARD', 'PIX']);
export const family  = pgEnum('decline_family',
  ['issuer', 'funds', 'fraud', 'credential', 'network', 'auth', 'merchant']); // DD21
export const scope   = pgEnum('decline_scope', ['card', 'pix']);

export const rollupMinute = pgTable('rollup_minute', {
  bucket:         timestamp('bucket', { withTimezone: true }).notNull(),
  merchantId:     text('merchant_id').notNull(),
  providerId:     text('provider_id').notNull(),
  country:        country('country').notNull(),
  paymentMethod:  method('payment_method').notNull(),
  issuerId:       text('issuer_id').notNull(),          // 'NA' em PIX
  attempts:       integer('attempts').notNull().default(0),
  approved:       integer('approved').notNull().default(0),
  amountUsdSum:   bigint('amount_usd_sum',   { mode: 'number' }).notNull().default(0),
  approvedUsdSum: bigint('approved_usd_sum', { mode: 'number' }).notNull().default(0),
}, (t) => [
  // DD12: 5 dimensões. card_brand e card_type NÃO entram.
  primaryKey({ columns: [t.bucket, t.merchantId, t.providerId,
                         t.country, t.paymentMethod, t.issuerId] }),
  index('ix_rollup_bucket').on(t.bucket.desc()),
]);

export const incidents = pgTable('incidents', {
  incidentId:   uuid('incident_id').primaryKey(),
  fingerprint:  text('fingerprint').notNull(),
  dimensions:   jsonb('dimensions').notNull(),
  ciLow:        numeric('ci_low',  { precision: 6, scale: 5 }).notNull(),   // DD11
  ciHigh:       numeric('ci_high', { precision: 6, scale: 5 }).notNull(),
  startedAt:    timestamp('started_at', { withTimezone: true }).notNull(),
  startedAtExact: boolean('started_at_exact').notNull().default(true),
  costUsdPerMin:  bigint('cost_usd_per_min', { mode: 'number' }).notNull(),
  evidence:     jsonb('evidence').notNull(),
  embedding:    vector('embedding', { dimensions: 1536 }),                  // DD15
}, (t) => [
  index('ix_incident_fingerprint').on(t.fingerprint),
  index('ix_incident_embedding')
    .using('hnsw', t.embedding.op('vector_cosine_ops')),
]);
```

**⚠️ Três coisas que o Drizzle não gera sozinho**

1. **`CREATE EXTENSION vector`.** O `drizzle-kit` não emite isso. Precisa de uma migration manual **antes** de todas as outras, ou o `push` quebra na tabela de incidentes. Colocar em `drizzle/0000_extensions.sql` e garantir que roda primeiro.
2. **Índices parciais e CHECKs compostos**, como o `CHECK` que impede código de cartão em transação PIX. Vão em migration manual acrescentada depois do `generate`.
3. **Seeds.** São um script `tsx` separado, lendo os CSVs de `db/seeds/`.

**Fluxo**

```bash
# H+0 → H+3, schema ainda se mexendo
pnpm drizzle-kit push

# quando o contrato congela
pnpm drizzle-kit generate      # gera a pasta drizzle/ para o repo público
pnpm drizzle-kit migrate       # aplica
pnpm db:seed
```

Uma nota para a sabatina: chegar com a pasta de migrations versionada, e não com um `push` de desenvolvimento, é o tipo de detalhe que separa "protótipo de hackathon" de "isso roda". Custa um comando na H+3.

### 6.4 A decisão do agente

**Mastra é o framework do módulo agêntico.** A decisão considera o SDK de
agentes da OpenAI, LangGraph JS e um loop ReAct manual, mas escolhe Mastra pela
integração nativa com TypeScript, ferramentas tipadas, observabilidade, evals,
Studio e suporte a múltiplos providers. O custo aceito é uma dependência mais
ampla e maior superfície conceitual durante o desafio de 24 horas.

Mastra fica restrito à orquestração do julgamento agêntico. Regras numéricas e
de negócio continuam determinísticas e independentes do framework, cada chamada
é preservada em `investigation_steps`, e qualquer falha, timeout ou esgotamento
do budget cai no beam search. O contrato completo e as alternativas estão em
`flight_logs/ai_agent_module.md`.

#### 6.4.1 Divisão dos modelos

| Papel | Modelo | Por quê |
|---|---|---|
| Investigador | **GPT-5.6 Sol** | É o carro-chefe para raciocínio e uso de ferramenta. O investigador escolhe qual dimensão explorar e quando parar — é aqui que a qualidade do modelo aparece |
| Narrador | **GPT-5.6 Terra** | Duas saídas de texto a partir de um objeto de evidência fechado. Tarefa bem definida, e a latência é percebida direto na UI |
| Reserva | **GPT-5.6 Luna** | Se o Terra estourar rate limit durante a demo. Configurável por variável de ambiente |

⚠️ **Conferir as strings exatas de modelo na documentação antes de codar.** A nomenclatura da OpenAI mudou de geração recentemente e as fontes de terceiros ainda citam nomes aposentados. Colocar os identificadores em `.env`, nunca no código, para que trocar seja edição de uma linha.

**Function calling em vez de prompt livre.** As seis ferramentas são declaradas como funções tipadas, geradas a partir dos mesmos schemas Zod do pacote `contracts`. Isso mantém a regra da §3 deste documento: o agente não recebe transação crua, só chama função que devolve métrica.

### 6.5 Dependências

```jsonc
// packages/app
{
  "dependencies": {
    "fastify": "^5",
    "@fastify/cors": "^10",
    "postgres": "^3",
    "drizzle-orm": "^0.3",
    "ioredis": "^5",
    "zod": "^3",
    "pino": "^9",
    "openai": "^5",
    "yaml": "^2"           // playbooks
  },
  "devDependencies": { "tsx": "^4", "vitest": "^2", "typescript": "^5", "drizzle-kit": "^0.3" }
}

// packages/web
{
  "dependencies": {
    "react": "^19", "react-dom": "^19",
    "@tanstack/react-query": "^5",
    "recharts": "^2",
    "lucide-react": "^0.4"
  },
  "devDependencies": { "vite": "^6", "tailwindcss": "^4", "typescript": "^5" }
}
```

Não entram: query builder para o cubo, biblioteca de estatística, biblioteca de SSE, gerenciador de estado global, biblioteca de cron.

### 6.6 Wilson em TypeScript

Para tirar qualquer dúvida sobre a dependência numérica:

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

export type CellState = 'MATERIAL_DROP' | 'HEALTHY' | 'MONITORING' | 'INSUFFICIENT_EVIDENCE';

export function evaluate(
  k: number, n: number, expected: number,
  deltaPp: number, minVolume: number,
): { state: CellState; ci: Interval } {
  const limit = expected - deltaPp / 100;
  const ci = wilson(k, n);
  if (ci.high < limit) return { state: 'MATERIAL_DROP', ci };
  if (ci.low > limit) return { state: 'HEALTHY', ci };
  return { state: n < minVolume ? 'INSUFFICIENT_EVIDENCE' : 'MONITORING', ci };
}
```

Isso é o motor de detecção inteiro. Tudo o mais é SQL e contagem.

### 6.7 Subir o ambiente

```bash
pnpm i
docker compose up -d              # postgres+pgvector, redis
pnpm drizzle-kit migrate && pnpm db:seed
pnpm --filter generator dev       # ~60 TPS
pnpm --filter app dev             # motor + API
pnpm --filter web dev             # UI
```

Quatro comandos depois do clone. Vale medir isso: um README em que o juiz roda o projeto em menos de dois minutos é a diferença entre "repo público" como checkbox e como argumento.

**Desvio registrado:** na prática o time roda contra Postgres+pgvector e Redis
gerenciados na nuvem (Railway), não contra o `docker compose up -d` acima —
não há `docker-compose.yml` no repositório. Ver
`flight_logs/infra_gerenciada_na_nuvem.md` para o porquê. `pnpm i` +
`pnpm drizzle-kit migrate` (`DATABASE_URL`/`REDIS_URL` já apontando pra nuvem
via `.env`) substituem a etapa do docker.

### 6.8 Riscos da stack

**Precisão de ponto flutuante em dinheiro.** JS não tem decimal nativo. Por isso todo valor monetário é `BIGINT` em unidades menores no banco. O `bigint({ mode: 'number' })` do Drizzle resolve o boundary — centavos cabem folgado em 2^53. **Mas as queries do cubo passam por `db.execute` cru, e ali o postgres.js devolve string.** Converter explicitamente ao ler resultado de SQL cru, e nunca `float` para dinheiro.

**Loop de eventos bloqueado.** O beam search com profundidade 3 sobre 90 células é trivial, mas se alguém escrever uma query por célula em série, o SSE trava. Uma query agregada por nível, não uma por célula.

**Timezone.** Três países, três fusos. Tudo `TIMESTAMPTZ` em UTC no banco, conversão só na renderização. O `started_at` exibido como "14:03" precisa saber de qual país está falando.

**Chave da API e rate limit.** A demo depende deles. Três defesas: uma segunda chave de outra conta, o modelo de reserva configurável por `.env`, e o narrador com template determinístico de fallback. A UI nunca pode ficar em branco porque uma chamada falhou na frente do júri.

**Modelo de raciocínio e latência.** O investigador faz até 12 chamadas de ferramenta em sequência. Se cada uma levar alguns segundos, o diagnóstico demora mais que a detecção, e isso aparece na demo. Medir cedo, e se necessário reduzir o budget para 8 passos — o beam search determinístico já entrega a célula, o agente só precisa refinar e justificar.

---

## 7. Flight logs — registro de decisões importantes

O briefing (`spec.md` §6) cobra um *decision log*: alternativas consideradas e o porquê da escolha. Neste projeto ele é o diretório `flight_logs/`, um arquivo por decisão, escrito na hora em que a decisão é tomada — não reconstruído na véspera da entrega.

### 7.1 Quando criar

Cria flight log a decisão que:

- trava uma nova `DD` ou supersede uma existente;
- resolve uma pendência `P1`–`P4`;
- fixa um contrato de dados público, uma das três fronteiras da §3, a stack (§6) ou uma dependência de produção;
- descarta uma alternativa que a sabatina provavelmente vai questionar;
- assume uma simplificação consciente longe do comportamento real do domínio (PIX síncrono, malha de roteamento completa, câmbio diário).

**Não** cria flight log: refactor, renomeação, escolha de implementação local e reversível, detalhe já fechado por teste, mudança só de formatação ou texto. Na dúvida, pergunta ao usuário antes de decidir.

### 7.2 Formato

- Um arquivo por decisão, nome em `snake_case`, conteúdo em português.
- Markdown simples, **sem** front matter YAML — exceção à §2.1. Vai publicado na plataforma da hackathon só com as quatro seções.
- Corpo em quatro seções, nesta ordem: **título** (decisão em uma linha), **opções consideradas**, **o que escolhemos**, **por quê** — e o "por quê" inclui o que a escolha custa, não só o benefício.
- Ao criar o arquivo, acrescenta a linha no índice de `flight_logs/README.md`.
- Se a decisão também trava uma `DD` ou fecha uma `P`, `context/schema.md` é atualizado no mesmo commit; os dois não podem divergir.
