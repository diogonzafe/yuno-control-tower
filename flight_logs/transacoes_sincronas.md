---
title: "Flight log — Transações Síncronas"
---

# Transações Síncronas

**Decisões travadas:** DD2 (tudo síncrono) e DD1 (sem retry).

## Opções consideradas

- **Ciclo de vida assíncrono** — estado `PENDING`, evento posterior de
  atualização de status, retry de tentativa.
- **Tudo síncrono** — status final (`SUCCESS` / `DECLINED`) no instante do
  evento; PIX modelado como aprovação imediata.

## O que escolhemos

Tudo síncrono. 1 pedido = 1 tentativa, sem retry, sem `PENDING`, sem evento de
atualização. `transaction_id` e `merchant_order_id` ficam 1:1.

## Por quê

- Conversão vira `approved / attempts` na célula — simplifica o cubo inteiro e as
  duas tabelas de rollup.
- Remove estado e um caminho de evento que não agregam ao diagnóstico no prazo de
  24h.
- É simplificação consciente (PIX real tem confirmação assíncrona), registrada
  aqui no decision log.
