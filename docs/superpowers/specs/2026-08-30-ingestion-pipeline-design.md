---
title: "The Control Tower — Design da ingestão (consumer + rollups)"
doc_id: "YCT-ING-001"
doc_related:
  - "YCT-RULES-001"
  - "YCT-AGENTS-001"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/transaction_event_contract.md"
  - "flight_logs/micro_batch_ingestion_with_dedup.md"
domain: "ingestion"
dimension_schema: ["merchant", "provider", "country", "payment_method", "issuer", "decline_code"]
time: "2026-08-30T01:15:00Z"
---

# Design da ingestão (consumer + rollups)

Consome o Redis Stream que o gerador (`packages/generator`, de outro
integrante) alimenta a ~60 TPS, grava cada transação em `transactions` e
mantém `rollup_minute` e `rollup_declines_minute` atualizados. Não julga nada
— só contabiliza (`roadmap.md` §2, "14:03 — as transações entram"). Detecção,
diagnóstico e narrador ficam fora deste spec.

## Contexto

- Schema Postgres e migrations já existem e estão aplicadas (`context/schema.md`
  §7, `packages/app/src/db/schema.ts`).
- `packages/contracts`, `packages/generator` e `packages/app/src/ingest` ainda
  não têm conteúdo — este spec cobre `contracts` e `app/src/ingest`.
  `generator` é responsabilidade de outro integrante; este design só define o
  contrato que os dois lados compartilham.
- Trabalho isolado na branch `feature/ingest`, criada a partir de `main` depois
  do esqueleto de pacotes (`592c5e1`), para não colidir com quem está
  construindo o gerador em paralelo.

## Arquitetura

```
generator (outro integrante)
    │  XADD stream:transactions * payload <json>
    ▼
Redis Stream "stream:transactions"
    │  XREADGROUP GROUP ingest app-1 COUNT 100 BLOCK 500 ... >
    ▼
packages/app/src/ingest/consumer.ts   ── laço de leitura, XACK, XAUTOCLAIM
    │  lote de eventos parseados e válidos
    ▼
packages/app/src/ingest/rollup.ts     ── aggregateDeltas() [função pura]
    │  deltas por célula
    ▼
Postgres: transactions, rollup_minute, rollup_declines_minute
```

`consumer.ts` cuida de tudo que é Redis (grupo, leitura, ack, recuperação de
pendências). `rollup.ts` não sabe que Redis existe — recebe uma lista de
transações já validadas e devolve deltas, além de expor os upserts. Essa
separação é deliberada: `rollup.ts` é a mesma peça que o corte transversal e a
varredura retroativa (fases futuras) vão reaproveitar (`rules.md` §1, DRY), e
não pode carregar nada específico do transporte.

## Contrato do evento

Ver `flight_logs/transaction_event_contract.md` para as opções
descartadas e o porquê. Resumo do que entra em `packages/contracts/src/transaction.ts`:

- `transactionEventSchema`: Zod, espelha 1:1 as colunas de `transactions`
  (`schema.md` §7). `transaction_id` é gerado por quem produz o evento — é a
  chave de deduplicação da ingestão.
- `.refine()` cruzado: `status === 'DECLINED' ⟺ declineCode` presente
  (espelha a `CHECK decline_code_consistency`); `paymentMethod === 'PIX' ⇒
  country === 'BR'` (DD5).
- Transporte: um único field `payload` no `XADD`, contendo
  `JSON.stringify(event)`. O consumer faz `JSON.parse` seguido de
  `transactionEventSchema.safeParse`.

## Pipeline de processamento

Ver `flight_logs/micro_batch_ingestion_with_dedup.md` para as opções
descartadas e o porquê. Resumo do fluxo:

**Setup (`consumer.ts`, na inicialização):**
`XGROUP CREATE stream:transactions ingest 0 MKSTREAM`, ignorando `BUSYGROUP`.
Começa do id `0` (não `$`) para não perder eventos emitidos antes do `app`
terminar de subir. Consumer group `ingest`, consumer name `app-1` — só existe
um processo `app` (`rules.md` §6.2).

**Laço principal, por iteração:**

1. `XREADGROUP GROUP ingest app-1 COUNT 100 BLOCK 500 STREAMS stream:transactions >`.
2. Parse de cada entrada: `JSON.parse(payload)` → `transactionEventSchema.safeParse`.
   Inválidos são separados aqui (tratados na seção de erros).
3. Insert em lote: `INSERT INTO transactions ${sql(validRows)} ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`.
4. Filtra `validRows` para as que voltaram no `RETURNING` — só essas são
   "novas de verdade". Passa a lista para `aggregateDeltas()` em `rollup.ts`,
   que faz o floor de `created_at` pro minuto e soma `attempts`/`approved`/os
   três somatórios de valor por célula de 5 dimensões, e a contagem por
   célula + `decline_code`.
5. Dois upserts em lote — um por tabela de rollup — cada um uma única
   instrução `INSERT ... ON CONFLICT (pk) DO UPDATE SET attempts =
   rollup_minute.attempts + excluded.attempts, ...` cobrindo todas as células
   tocadas no lote.
6. Passos 3–5 dentro de uma transação Postgres (`sql.begin(...)`). `XACK` do
   lote inteiro só depois do commit.

**Simplificação assumida:** `rollup_minute.latency_p50_ms` fica `NULL` neste
v1. A coluna existe no schema, mas `schema.md` §2 já marca `latency_ms` como
cortável, e um p50 incremental correto sem guardar todas as amostras é
trabalho real para algo que a detecção não usa (Wilson não depende de
latência). Se sobrar tempo, dá para estimar em lote com `percentile_cont`
depois — não bloqueia nada do resto do sistema.

## Tratamento de erro e recuperação

- **Evento malformado** (`safeParse` falha): log em `error` com o payload
  bruto e o motivo, `XACK` mesmo assim. Uma mensagem podre não pode travar o
  grupo inteiro esperando reprocessamento para sempre.
- **Falha de banco no meio do lote:** a transação Postgres não commitou, nada
  foi feito, não há `XACK` — as mensagens ficam pendentes no PEL do consumer
  group. Retry em processo com backoff curto (até 5 tentativas) sobre o mesmo
  lote já parseado em memória. Se continuar falhando, log em `fatal` e o
  processo encerra — não há sentido em manter o `app` de pé se nem ingestão
  nem detecção conseguem falar com o banco.
- **Recuperação ao reiniciar:** antes do laço principal,
  `XAUTOCLAIM stream:transactions ingest app-1 0 0` reclama qualquer coisa
  pendente de uma execução anterior e processa pelo mesmo pipeline. Como o
  pipeline já é idempotente (o `RETURNING` filtra o que já foi inserido),
  reprocessar mensagem já commitada e não confirmada é seguro: o delta de
  rollup dá zero e ela só recebe o `XACK` que faltava.

## Testes

Ordem de escrita (TDD, `rules.md` §4 e §1):

1. `aggregateDeltas` (`rollup.ts`) — função pura, sem banco: lote fixo de
   transações validadas → deltas exatos por célula em `rollup_minute` e por
   célula + código em `rollup_declines_minute`. É o teste que `AGENTS.md` já
   pede ("agregados exatos a partir de lotes fixos de eventos") e o mais
   importante dos três.
2. `transactionEventSchema` — tabela de casos válidos/inválidos, incluindo os
   dois `.refine()` (consistência de `decline_code`, PIX⇒BR).
3. Idempotência ponta a ponta — processar o mesmo lote duas vezes contra um
   Postgres real (o da `.env`) e comparar os rollups antes/depois da segunda
   passada: têm que ser idênticos. Único teste que precisa de banco de
   verdade; o resto é puro.

## Fora de escopo deste spec

Consumo dos rollups pelo detector (gatilho absoluto, corte transversal,
Wilson), UI, e qualquer coisa em `packages/generator`. O pipeline de
`aggregateDeltas` é desenhado para ser reaproveitado por essas fases futuras,
mas implementá-las não é parte deste trabalho.
