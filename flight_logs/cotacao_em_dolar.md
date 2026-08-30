---
title: "Flight log — Dólar como moeda padrão mas com registro de moeda local"
---

# Dólar como moeda padrão mas com registro de moeda local

**Decisões travadas:** DD3 (moeda local + normalização em USD) e DD9 (câmbio no
padrão de mercado).

## Opções consideradas

- **Só USD** na transação.
- **Só moeda local**, recalculando USD sob demanda com a taxa corrente.
- **Cotação intradiária**, transação a transação.
- **Local + USD normalizado**, com taxa/data/fonte congeladas na transação e uma
  taxa de referência por moeda por dia.

## O que escolhemos

Padrão contábil de mercado. Cada transação grava `amount_minor` (local),
`amount_usd_minor` (derivado, congelado na criação), `fx_rate`, `fx_rate_date` e
`fx_source`. `fx_rates` é série por data; uma taxa de referência por moeda,
fixada no início do dia, vale das 00:00 às 23:59. O custo do incidente é
reportado por país na moeda local e em USD para o ranking global de prioridade —
as duas leituras saem da mesma linha, sem recomputar nada.

## Por quê

- Auditoria: o custo de um incidente de ontem é sempre medido com o dólar de
  ontem, independentemente do que a tabela de câmbio contenha hoje. **Nunca
  recalcular USD histórico.**
- Reconciliação: processadores de pagamento não convertem transação a transação
  com cotação intradiária.
- Importa mais com ARS do que com BRL ou MXN.
- Para a demo, `fx_source = 'MOCK'` é aceitável desde que declarado (referências
  reais: PTAX/BCB, DOF/Banxico, Comunicación A3500/BCRA).
