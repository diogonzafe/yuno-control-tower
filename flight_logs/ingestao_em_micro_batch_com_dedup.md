---
title: "Flight log — Ingestão em micro-batch com deduplicação via RETURNING"
---

# Ingestão em micro-batch com deduplicação via RETURNING

## Opções consideradas

- **Mensagem a mensagem** (`XREADGROUP COUNT 1`): insert em `transactions` +
  upsert dos dois rollups por evento, uma transação Postgres por evento.
- **Micro-batch** (`XREADGROUP COUNT ~100 BLOCK 500ms`): insert em lote com
  `ON CONFLICT (transaction_id) DO NOTHING RETURNING`, agregação em memória
  dos deltas de rollup calculada só a partir das linhas devolvidas, um upsert
  por tabela de rollup, tudo em uma única transação Postgres, `XACK` do lote
  inteiro só depois do commit.
- **Buffer com flush por tempo/tamanho** desacoplado do tamanho do read
  (double buffering), para suavizar ainda mais a escrita.

## O que escolhemos

Micro-batch com deduplicação via `RETURNING`.

## Por quê

- A 60 TPS, mensagem a mensagem significa até ~180 round-trips/s ao Postgres
  (insert + até dois upserts por evento) — é o antipadrão que `rules.md` §6.8
  já sinalizava como risco de travar o loop de eventos ("uma query por célula
  em série, e o SSE trava").
- O `RETURNING` do `ON CONFLICT DO NOTHING` resolve reentrega do consumer
  group de graça: se o processo cair entre o insert e o `XACK`, reprocessar o
  mesmo lote produz um `RETURNING` vazio para as linhas já commitadas, e o
  delta de rollup calculado a partir dele é zero — sem tabela de
  deduplicação separada, sem contador idempotente escrito à mão.
- Buffer com flush desacoplado (terceira opção) resolve um problema de
  suavização de escrita que não existe a 60 TPS — complexidade sem retorno,
  contra o YAGNI de `rules.md` §1.
- **Custo assumido:** a função de agregação em memória por lote
  (`aggregateDeltas`) é mais código e mais superfície de teste do que o
  caminho ingênuo mensagem a mensagem. Aceito porque é a mesma peça que o
  corte transversal e a varredura retroativa vão reaproveitar depois — não é
  código de uso único.
