---
title: "The Control Tower — Design do orchestrate (incidentes, ciclo de vida e memória)"
doc_id: "YCT-ORCH-001"
doc_related:
  - "YCT-RULES-001"
  - "YCT-DETECT-001"
  - "YCT-DIAG-001"
  - "YCT-AGENT-002"
  - "YCT-WIRE-001"
domain: "incident-orchestration"
dimension_schema: []
time: "2026-08-30T12:00:00Z"
---

# Design do `orchestrate/`

## 1. Problema

`context/detector.md` §1.2 e `rules.md` §6.3 reservam ao `orchestrate/` a escrita
em `incidents`, o ciclo de vida e a memória. O módulo não existe. O que existe
hoje está no lugar errado e incompleto:

- `agent/persistence.ts` faz `upsertIncidentFromEvidence`, chamado por
  `agent/coordinator.ts`. É o finding I6 da última revisão: `rules.md` §6.3
  atribui essa escrita ao `orchestrate/`, não ao `agent/`.
- `'open'` é o único status que alguém já escreveu. Nada nunca escreve
  `resolved_at`. Um incidente de vinte minutos vira vinte cards permanentes que
  a UI não tem como limpar.
- `similarIncidents` é sempre `[]`, embora o campo esteja no contrato congelado
  e o prompt do investigador já o interpole (`agent/investigator.ts`).
- A tabela `incidents` tem **zero linhas**. A linha só nasceria no fim de
  `coordinator.handleSignal`, isto é, depois de investigador e narrador — cerca
  de trinta segundos de LLM depois de o tick ter confirmado a queda.

## 2. Escopo

**Dentro:** `orchestrate/incidents.ts`, `orchestrate/lifecycle.ts`,
`orchestrate/memory.ts`; a extração da escrita de incidentes para fora de
`agent/`; a religação do `run.ts`.

**Fora:** qualquer migration (o schema já tem todas as colunas, inclusive o
`check` de status); qualquer mudança em `packages/contracts`; pgvector e
similaridade vetorial (DD15 travou fingerprint exato como único caminho de
reconhecimento); `packages/web`.

`fingerprint.ts` **não** é criado. O fingerprint já é calculado por
`fingerprintOf` em `diagnose/evidence.ts`, e é lá que ele pertence — quem monta
o `EvidenceObject` monta a identidade dele junto
(`flight_logs/who_assembles_the_evidence_object.md`). O `rules.md` §6.3 lista
`orchestrate/fingerprint.ts` como previsão de layout, não como obrigação de
duplicar código que já existe e já está testado.

### 2.1 Sobre a lista de corte

`roadmap.md` §7 lista "reconhecimento de repetição inteiro" como corte #3. A
memória entra mesmo assim, por três razões:

1. `spec.md` §5 **pontua** o item: "reconhecer incidente repetido ('isso já
   aconteceu na terça') usando memória" é bônus de julgamento.
2. DD15 já reduziu a memória a uma query indexada. O índice
   `ix_incident_fingerprint` existe, o campo `similarIncidents` está no contrato
   congelado, e o prompt já o consome. Sobra uma consulta e um fio.
3. A lista de corte é ordenada de baixo pra cima: 1 harness, 2 vetorial,
   3 repetição, 4 camada agêntica. A #4 foi construída inteira. Cortar a #3
   mantendo a #4 inverte a ordem do próprio procedimento.

A memória continua sendo o primeiro candidato a corte **dentro** deste design:
`lifecycle.ts` e `incidents.ts` não dependem dela.

## 3. Arquitetura

```
packages/app/src/orchestrate/
  incidents.ts   — o único lugar do sistema que escreve na tabela incidents
  lifecycle.ts   — a máquina de estados, pura + uma query agregada por tick
  memory.ts      — recall por fingerprint exato (DD15)
```

### 3.1 `incidents.ts`

Duas operações, e a separação entre elas é a fronteira #3 do `rules.md` §3
(*todo caminho agêntico tem fallback determinístico*):

- `openOrUpdate(evidence: EvidenceObject): Promise<IncidentUpsert>` —
  determinística, roda no tick, não conhece LLM. É o
  `upsertIncidentFromEvidence` de hoje, movido, **menos** os campos de
  narrativa. Devolve `{ incidentId, status }` para o chamador saber se abriu
  ou reconfirmou.
- `attachNarrative({ incidentId, narrativeOps, narrativeExec, playbookId }): Promise<void>` —
  o enriquecimento agêntico, um `UPDATE` na linha que já existe.

Dedup por fingerprint entre linhas com `status <> 'resolved'`, como hoje. Um
fingerprint já resolvido **abre linha nova** — é isso que dá à memória um
histórico para recontar.

`agent/persistence.ts` perde `upsertIncidentFromEvidence` e fica apenas com
`investigation_runs` e `investigation_steps`, que é o que o `rules.md` §6.3
atribui ao `agent/`. `agent/coordinator.ts` deixa de criar incidente: recebe o
`incidentId` pronto e chama `attachNarrative`.

### 3.2 `lifecycle.ts`

A máquina de estados é `'open' → 'monitoring' → 'resolved' → 'inconclusive'`
(`roadmap.md` §5). A recuperação é detectada por **silêncio do tick com
histerese**, não por um teste positivo: `runDetectionTick` já devolve `signals`
e `evidenceGaps` a cada minuto, e reimplementar o julgamento de recuperação
duplicaria a lógica que o detector já faz.

A peça que dispensa estado novo: `openOrUpdate` grava
`detected_at = windowBucket` **toda vez** que a célula reconfirma. Logo "janelas
quietas" é derivado — `bucket − detected_at` — sem coluna nova, sem contador em
memória e sobrevivendo a restart do processo.

As três transições, todas por query agregada (`rules.md` §6.8: nunca uma query
por célula em série):

| Transição | Gatilho | Onde |
|---|---|---|
| `open → monitoring` | a linha já existia quando `openOrUpdate` rodou: reconfirmação | dentro do próprio `openOrUpdate` |
| `open`/`monitoring` → `resolved` | `detected_at < bucket − 3 min` | uma query por tick |
| `open`/`monitoring` → `inconclusive` | a célula apareceu em `evidenceGaps` | uma query por tick |

`monitoring` é o que o `roadmap.md` §5 chama de "atualiza sem re-alertar, que é
o que evita 36 alertas num incidente de 3h".

A histerese de 3 janelas é simétrica ao `PERSISTENCE_WINDOWS = 3` que confirma o
sinal. Uma única janela quieta não resolve: faria flapping, fechando o incidente
numa janela de volume baixo e reabrindo na seguinte como incidente novo — o
mesmo ruído que a máquina de estados existe para evitar, e que ainda inflaria
falsamente o histórico de repetição.

`inconclusive` cobre o caso em que o volume caiu abaixo de `MIN_VOLUME`: não é
possível **afirmar** que recuperou, e o sistema admite isso em vez de fingir
resolução. É o primeiro bônus do `spec.md` §5. Detalhe de implementação:
`EvidenceGap` carrega `dimensions`, não `fingerprint`, então o casamento com a
linha do incidente é pelas dimensões, comparadas como JSON.

A ordem importa dentro do tick: `openOrUpdate` roda **antes** da reconciliação,
para que uma célula reconfirmada neste bucket já tenha `detected_at` atualizado
e não seja resolvida pela query da mesma passada.

### 3.3 `memory.ts`

```sql
SELECT incident_id, fingerprint, dominant_decline, playbook_id,
       started_at, resolved_at, cost_usd_minor
  FROM incidents
 WHERE fingerprint = $1
   AND status = 'resolved'
   AND incident_id <> $2
 ORDER BY detected_at DESC
 LIMIT 3
```

Usa o índice `ix_incident_fingerprint`, que já existe. Alimenta
`similarIncidents` em `buildRequest` do coordinator.

`SimilarIncident` exige `rootCauseDimension`, que **não** é coluna de
`incidents` nem campo do `EvidenceObject`. Deriva-se de `playbook_id`: há quatro
playbooks, um por dimensão causal (`provider-default` → `provider`), e
`null` quando não houver playbook. O campo é `.nullable()` no contrato, então
`null` é válido e não força invenção de dado.

O `summary` de cada incidente recordado é montado deterministicamente a partir
das colunas — nunca gerado por LLM. Ele entra no prompt do investigador, e um
resumo gerado por modelo realimentaria texto de modelo como se fosse evidência.

## 4. Fluxo por tick

O `onResult` do scheduler (`run.ts`) passa a fazer, nesta ordem:

1. `incidents.openOrUpdate(e)` para cada `EvidenceObject` → `incidentId` real,
   em menos de um segundo. O scheduler já roda o diagnóstico determinístico
   completo a cada tick e já entrega `evidence[]` com fingerprint calculado
   (`emitDeterministicEvidence` está ligado), então nada novo é pedido ao
   detector.
2. `lifecycle.reconcile({ bucket, evidenceGaps })` → fecha o que sumiu e marca
   o que ficou sem volume.
3. Broadcast SSE, agora carregando `incidentId` de verdade em vez de só
   fingerprint.
4. `coordinator.handleSignal(signal, incidentId)` em background → chama
   `attachNarrative` quando o investigador e o narrador terminarem.

Se a camada agêntica inteira for cortada (corte #4), os passos 1 a 3 continuam
entregando incidente completo, com evidência, custo e prioridade. O agente
passa a ser estritamente aditivo, que é o que a fronteira #3 do `rules.md` §3
exige.

## 5. Erros

- Falha de escrita em `incidents` no tick é registrada e **não** derruba o tick:
  o próximo bucket reconcilia, porque `openOrUpdate` é idempotente por
  fingerprint e a reconciliação é derivada de `detected_at`, não de estado
  acumulado em memória.
- Falha em `attachNarrative` deixa o incidente sem narrativa, com o restante
  intacto. A UI mostra evidência e custo; o texto chega no próximo tick que
  reconfirmar a célula.
- Falha na memória devolve `[]`, e a investigação segue sem histórico. A
  memória nunca é caminho crítico.

## 6. Testes

- `lifecycle.test.ts` — tabela determinística de transições sobre `detected_at`
  fixo, sem banco: reconfirmação no mesmo bucket; uma janela quieta (não
  resolve); três janelas quietas (resolve); célula em `evidenceGaps` (marca
  `inconclusive`); incidente já `resolved` (não é tocado de novo).
- `incidents.integration.test.ts` — `openOrUpdate` duas vezes com o mesmo
  fingerprint dá **uma** linha e faz bump de `detected_at`; depois de
  `resolved`, o mesmo fingerprint abre linha **nova**; `attachNarrative` não
  altera nenhum campo numérico da linha.
- `memory.integration.test.ts` — devolve apenas `resolved`, exclui o incidente
  corrente, respeita o limite, e `rootCauseDimension` sai `null` quando não há
  playbook.

Testes de integração usam buckets em `1970-01-01` e deletam apenas o que
criaram, escopado pela PK completa. Há cerca de 90 mil linhas retroativas reais
no banco (2026-08-28 a 2026-08-29) que não podem ser tocadas.

## 7. O que este design deliberadamente não faz

- Não cria `orchestrate/fingerprint.ts`: duplicaria `diagnose/evidence.ts`.
- Não adiciona coluna de contador de janelas quietas: `detected_at` já carrega
  a informação, e uma migration a mais é risco a mais faltando horas.
- Não implementa o estado "em recuperação": cortado por escopo em
  `roadmap.md` §5.
- Não faz cache de narrativa por fingerprint. É desejável
  (`roadmap.md` §5) mas é otimização de latência, não de correção, e o
  `attachNarrative` assíncrono já tira o LLM do caminho crítico da tela.
