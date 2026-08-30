---
title: "The Control Tower — Design da fiação do detector (RollupSource + scheduler + API)"
doc_id: "YCT-WIRE-001"
doc_related:
  - "YCT-DETECT-001"
  - "YCT-RULES-001"
  - "YCT-AGENTS-001"
  - "YCT-ING-001"
  - "context/roadmap.md"
domain: "detection-runtime"
dimension_schema: ["merchant", "provider", "country", "payment_method", "issuer"]
time: "2026-08-30T05:30:00Z"
---

# Design da fiação do detector

Liga o motor de detecção — hoje completo, testado, e **mudo** — ao banco real e
a uma API HTTP/SSE. É a dívida da fase H+3→H+7 do `context/roadmap.md`:
`context/detector.md` §1.2 delega explicitamente "Scheduler / tick por minuto /
fiação no Fastify / SSE" e "Implementação de `RollupSource`" para esta branch.

Sem isso, os critérios de aceite 1 e 2 do `context/spec.md` §4 não são
demonstráveis, mesmo com a lógica correta.

## Contexto

Pronto e fora de escopo desta branch:

- `packages/app/src/detect/*` — `runDetectionTick(input): TickOutput`, função
  pura, 100% testada com fixtures em memória. Não toca banco.
- `packages/app/src/db/client.ts` — `db` (Drizzle) e `sql` (postgres.js).
- `packages/app/src/ingest/*` — ingestão completa, populando `rollup_minute`.
- `packages/contracts` — `ConfirmedDrop`, `EvidenceGap`, `EvidenceObject`.

Fora de escopo, e continua fora: `diagnose/`, `orchestrate/`, `agent/`, UI.

## Decisões tomadas no brainstorm

| Decisão | Escolha | Por quê |
|---|---|---|
| Destino dos sinais | Buffer em memória + SSE + REST | `orchestrate/` é quem escreve em `incidents` (`detector.md` §1.2). Gravar aqui invadiria o escopo dele e criaria conflito. |
| Processos | Ingest + scheduler + API num processo só | `rules.md` §6.2 é explícito: o `app` "consome o stream, roda rollup + detector, e serve REST/SSE". Hoje o ingest tem entrypoint separado — esta branch corrige isso. |
| Superfície da API | SSE + sinais + lacunas + série de conversão | Cobre as 3 primeiras telas do mínimo viável de UI (`roadmap.md` §281). |
| Disparo do tick | Timer de 60s com query por tick | Independente do ingest: se a ingestão morrer, o detector continua rodando e o silêncio fica **visível**, em vez de parecer saúde. |

Alternativas descartadas para o disparo: **tick disparado pelo ingest** (dado
garantidamente completo, mas ingest travado = detector mudo, indistinguível de
"está tudo bem" — o pior modo de falha numa demo); **cache de histórico em
memória** (90 células × 120 min ≈ 10 mil linhas por tick é trivial para
Postgres; cachear seria otimização prematura, `rules.md` §1).

## Arquitetura

```
packages/app/src/
├── db/queries.ts          # implementa RollupSource + carrega merchants/coverage
├── detect/scheduler.ts    # laço de 60s: carrega → runDetectionTick → entrega
├── api/
│   ├── signal-store.ts    # ring buffer de sinais e lacunas
│   ├── sse.ts             # broadcast, sem biblioteca
│   ├── routes.ts          # REST
│   └── server.ts          # monta o Fastify
└── run.ts                 # entrypoint único: ingest + scheduler + server
```

`detect/scheduler.ts` fica no `detect/` porque é runtime de detecção; `api/`
permanece exclusivamente sobre HTTP.

## Camada de dados (`db/queries.ts`)

Três funções, todas com Drizzle **tipado** — não `db.execute` cru. São selects
simples, não as queries de `GROUP BY` dinâmico do cubo; o SQL cru continua
reservado ao `diagnose/`, como `rules.md` §6.3.1 determina. Isso também elimina
de graça o risco do §6.8: `amountUsdSum`/`approvedUsdSum` são
`bigint({ mode: "number" })` e voltam como `number`.

- `getWindowRollups(bucket)` / `getHistory(from, to)` — implementam a interface
  `RollupSource` que já existe declarada no arquivo.
- `loadMerchantConfigs()` — **armadilha:** `expectedConversion` e
  `minMaterialDropPp` são `numeric` sem mode explícito, logo Drizzle devolve
  **string**. Exigem `Number()` explícito; sem isso o Wilson compara número com
  string e o detector silenciosamente nunca dispara.
- `loadRoutingCoverage()` — as 12 linhas do DD13.

`rollup_minute.bucket` é `timestamp` (vem como `Date`), mas `RollupRow.bucket` é
`string` ISO. A conversão acontece na borda do SQL, uma vez, para que o motor
puro receba exatamente o formato que seus testes já usam.

## Scheduler (`detect/scheduler.ts`)

A cada 60 segundos:

1. **Alvo** = `floorToMinute(agora − 10s) − 1min`. A folga de 10s absorve o lag
   do ingest; o `floor` mais a comparação com o último bucket processado torna o
   cálculo imune ao drift do `setInterval` e a disparos duplicados. Os 10s custam
   10 segundos de latência, irrelevantes contra os 3 minutos que a regra de
   persistência já impõe.
2. **Catch-up limitado a 10 buckets.** Se buckets foram pulados, processa do
   último+1 até o alvo, em ordem. Isso importa: pular um bucket quebraria a
   contagem de 3 janelas consecutivas e o incidente nunca confirmaria. No boot
   (sem último bucket), processa **só o mais recente** — sem backfill de 2h, que
   dispararia sinais velhos na largada.
3. Carrega `windowRows`, `history` (120 min, `ONSET_LOOKBACK_MIN`), `merchants` e
   `coverage`. Quatro queries por tick; os catálogos são recarregados a cada tick
   de propósito — 21 linhas no total, e cachear traria a pergunta de invalidação
   sem economia mensurável.
4. Chama `runDetectionTick`.
5. Entrega `signals` e `evidenceGaps` ao store e ao SSE; guarda `nextState`.

**`PersistenceState` fica em memória.** `detector.md` §9 permite explicitamente
("memória do processo ou tabela"). Custo declarado: reiniciar o processo zera as
sequências, então um incidente em curso leva mais 3 minutos para reconfirmar.
Aceitável, e evita uma tabela + migration que o `orchestrate/` provavelmente vai
querer desenhar do seu próprio jeito.

## API

**SSE** (`api/sse.ts`), sem biblioteca (`rules.md` §6.1): escreve direto no
`reply.raw` com headers de `text/event-stream`, mantém um `Set` de conexões,
remove no `close`, e envia um comentário `: keepalive` a cada 20s para não
morrer em proxy. Eventos: `signal` e `evidence-gap`.

| Rota | O quê |
|---|---|
| `GET /health` | estado do ingest, último tick, último bucket, `bucketLagMinutes`, conexões abertas |
| `GET /api/signals?limit=` | `ConfirmedDrop[]` do buffer, mais novo primeiro |
| `GET /api/evidence-gaps?limit=` | `EvidenceGap[]` — o bônus "admite que não sabe" (`spec.md` §5) |
| `GET /api/conversion?from=&to=&<dims>` | série temporal para o gráfico ao vivo |
| `GET /api/stream` | SSE |

`/api/conversion` **reusa `aggregateByBucket` de `detect/aggregate.ts`** em vez
de escrever agregação nova — é literalmente o que `rules.md` §1 exige ("as três
leituras do rollup usam a mesma função de agregação com parâmetros diferentes,
não três implementações").

O buffer é um ring com teto de 200 sinais e 200 lacunas.

## Erros e observabilidade

**Falha no tick:** o scheduler nunca morre. Captura, loga em `error`, e **não
avança** o cursor — o catch-up do minuto seguinte tenta de novo. Se a falha
persistir, o teto de 10 buckets faz o detector ficar para trás, e o `/health`
conta a verdade via `bucketLagMinutes`. É deliberado falhar **visivelmente** (lag
crescendo) em vez de silenciosamente (pulando buckets).

**Consequência declarada de juntar os processos:** o consumer do ingest chama
`process.exit(1)` após 5 retries de banco. No processo único isso derruba a API
junto. Mantido como está por escolha explícita no brainstorm. Como o banco é o
mesmo que o detector usa, ele estaria inoperante de qualquer forma; o que se
perde é a API conseguir *reportar* a falha.

**SSE:** escrever em socket morto lança — cada `write` é protegido e a conexão é
removida do `Set`, sem derrubar o broadcast para as outras.

## Testes

Ordem de escrita (TDD, `rules.md` §4 — determinístico primeiro):

1. **`scheduler.test.ts`** — lógica pura, com relógio e `RollupSource` injetados,
   sem timer e sem banco: cálculo do bucket-alvo (folga, drift, disparo
   duplicado), catch-up limitado a 10, boot processando só o mais recente, e
   falha de tick não avançando o cursor.
2. **`signal-store.test.ts`** — teto do ring, ordem (mais novo primeiro), `limit`.
3. **`sse.test.ts`** — formato do wire (`event:` + `data:` + linha em branco),
   conexão morta removida sem lançar.
4. **`routes.test.ts`** — via `app.inject()` do Fastify, mesmo padrão dos testes
   da API de injeção do gerador. Fonte falsa, sem banco.
5. **`queries.integration.test.ts`** — o **único** que precisa do banco real, e o
   mais importante: verifica que `expectedConversion` volta como `number` e não
   `string`, e que `bucket` vira ISO. É onde mora a falha silenciosa descrita
   acima.

**Verificação manual, no fim:** subir o processo único, injetar um incidente pela
API do gerador, e ver o `signal` chegar no SSE dentro de ~3 minutos (persistência
de 3 janelas). É a primeira vez que o sistema funciona ponta a ponta.

## Fora de escopo

Escrita em `incidents`, fingerprint com decline dominante, ciclo de vida,
memória/pgvector (`orchestrate/`); teste residual, beam search, peeling, custo,
prioridade (`diagnose/`); narrador e ferramentas (`agent/`); qualquer componente
de UI. O `EvidenceObject` não é montado aqui — `diagnose/evidence.ts` o monta,
conforme `flight_logs/quem_monta_o_evidence_object.md`.
