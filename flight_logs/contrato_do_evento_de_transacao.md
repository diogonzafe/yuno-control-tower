---
title: "Flight log — Contrato do evento de transação no Redis Stream"
---

# Contrato do evento de transação no Redis Stream

## Opções consideradas

- **Campos soltos** como field-value pairs do próprio `XADD` (um par por coluna).
- **Um único campo `payload`** com `JSON.stringify` do objeto completo.
- **Formato binário** (protobuf/avro), com schema registrado à parte.

## O que escolhemos

Um schema Zod em `packages/contracts/src/transaction.ts`, espelhando 1:1 as
colunas de `transactions` (`schema.md` §7), transportado como um único campo
`payload` (JSON) no stream. O `transaction_id` (UUID) é gerado por quem produz
o evento — é a chave de deduplicação contra reentrega do consumer group. Duas
validações cruzadas entram como `.refine()` no próprio schema, em vez de só
confiar na `CHECK` do Postgres: consistência `status`/`decline_code`, e
`payment_method = PIX ⇒ country = BR` (DD5).

## Por quê

- Redis Streams só guardam strings nos fields. Espalhar campos individualmente
  obriga a reconstruir tipo por campo na leitura (number/boolean/null viram
  string) — risco de bug silencioso de coerção. Payload único + Zod faz a
  coerção uma vez só, no ponto de entrada.
- Protobuf/avro dariam payload mais compacto e schema versionado, mas exigem
  toolchain adicional (geração de código, registro de schema) que não se paga
  num stream de ~60 TPS em 24h.
- Espelhar `transactions` em vez de inventar um shape de evento próprio evita
  uma camada de tradução (evento → DTO → linha de banco) mantida à mão; o
  schema Zod *é* a validação de entrada da tabela.
- **Custo assumido:** o gerador fica acoplado ao schema do banco por
  construção — se uma coluna de `transactions` mudar, o contrato muda para os
  dois lados ao mesmo tempo. Deliberado: o gerador já lê do mesmo Postgres
  para montar combinações válidas, então o acoplamento já existia de fato.
