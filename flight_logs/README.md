---
title: "Flight Logs — Decision Log Index"
doc_id: "YCT-FLIGHT-001"
doc_related:
  - "YCT-AGENTS-001"
  - "YCT-RULES-001"
domain: "decision-log"
dimension_schema: []
time: "2026-08-30T02:14:36Z"
---

# Flight Logs

This directory contains the implementation decisions made during the hackathon.

Each flight log records the decision title, the options considered, what we
chose, and why we chose it, including its costs and trade-offs.

Files:

1. `taxa_de_conversao_fixada.md` — Fixed expected conversion per merchant
2. `dados_historicos_d-2.md` — Historical data through D-2
3. `transacoes_sincronas.md` — Synchronous transactions
4. `quantidade_de_valores_dimensoes.md` — Number of values for each dimension
5. `cotacao_em_dolar.md` — USD normalization with local currency preservation
6. `ai_agent_module.md` — Mastra, investigator tools, memory, and playbook ownership
7. `contrato_do_evento_de_transacao.md` — Transaction event contract on the Redis Stream
8. `ingestao_em_micro_batch_com_dedup.md` — Micro-batch ingestion with deduplication via RETURNING
9. `deteccao_wilson.md` — Wilson detector and `ConfirmedDrop` output contract
10. `infra_gerenciada_na_nuvem.md` — Managed cloud Postgres/Redis instead of docker-compose
