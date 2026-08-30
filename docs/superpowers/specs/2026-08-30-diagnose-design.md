---
title: "The Control Tower — Motor de diagnóstico de causa raiz"
doc_id: "YCT-DIAG-001"
doc_related:
  - "YCT-DETECT-001"
  - "YCT-RULES-001"
  - "YCT-AGENTS-001"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/diagnosis_by_deficit_density.md"
  - "flight_logs/decline_mix_catalogue_reference.md"
  - "flight_logs/priority_by_conservative_cost.md"
domain: "diagnosis-engine"
dimension_schema:
  - "merchant"
  - "provider"
  - "country"
  - "payment_method"
  - "issuer"
  - "decline_code"
time: "2026-08-30T06:40:00Z"
---

# The Control Tower — Motor de diagnóstico de causa raiz

Frente F2 (`context/roadmap.md` §5, janela H+7→H+13), recortada para uma branch:
**só o diagnóstico determinístico, sem banco e sem camada agêntica.** Consome o
que `runDetectionTick` produz e devolve incidentes diagnosticados e priorizados.

---

## 1. Escopo

### 1.1 Dentro

- `packages/app/src/diagnose/`: teste residual, beam search, parcimônia,
  peeling, deslocamento da mistura de recusas, custo e prioridade.
- `runDiagnosis`, que compõe tudo acima para um bucket de 1 minuto.
- Extensão de `RollupRow` com `amountMinorSum`, sem a qual não há custo local.

### 1.2 Fora

| Item | Onde vive |
|---|---|
| SQL do cubo, implementação de `RollupSource` | branch de camada SQL |
| Escrita em `incidents`, fingerprint, ciclo de vida, memória / pgvector | `orchestrate/` |
| Objeto de evidência, contrato de handoff, as 6 ferramentas, Mastra, narrador | `agent/` |
| Casamento de playbook e aprovação humana | branch de playbooks |
| Scheduler, API, SSE | branch de API |

### 1.3 Premissa herdada

O detector emite sinais de profundidade 0 e 1 e, pela lacuna G1 de
`context/detector.md`, muitos deles são eco do mesmo problema. O diagnóstico
**não confia nesses sinais como candidatos**: usa apenas as raízes
merchant × país que eles nomeiam e re-deriva tudo do rollup. É o que mantém a
busca genérica sobre o cubo, exigência do trial by fire, e o que faz do beam
search um fallback honesto para a terceira fronteira de `context/rules.md` §3.

---

## 2. Layout de módulos

```
packages/app/src/diagnose/
├── constants.ts     # BEAM_WIDTH, MAX_DEPTH, SELECTION_TOLERANCE,
│                    #   MAX_INCIDENTS_PER_ROOT, MIN_DECLINES,
│                    #   DECLINE_WINDOWS_MIN, TEMPORAL_MIN_DECLINES,
│                    #   CURRENCY_BY_COUNTRY
├── types.ts         # DeclineRollupRow, DeclineCode, DeclineFamily
├── residual.ts      # residualDeficit()  — o primitivo único
├── beam-search.ts   # beamSearch() + cellKey()  — profundidade <= 3 (DD19)
├── parsimony.ts     # selectCausal()  — densidade, magnitude, parcimônia
├── peeling.ts       # peel()  — laço externo (DD18) + supressão de eco
├── decline-mix.ts   # declineMixShift() + disambiguateOutage()
├── cost.ts          # estimateImpact()  — ponta conservadora (DD11)
├── fixtures.ts      # cenários calculados à mão
└── run.ts           # runDiagnosis()  — a função de topo
```

---

## 3. O primitivo e seus três consumidores

`residualDeficit(rows, filter, expected, deltaPp, excluded)` relê uma fatia com
um conjunto de células recortado fora, devolvendo agregado, intervalo de Wilson,
estado e déficit em aprovações perdidas. Reusa `aggregate` e `evaluate` de
`detect/`; a lógica `approved / attempts` não é reescrita (`context/rules.md` §1).

| Consumidor | Uso |
|---|---|
| `beamSearch` | pontua cada candidato pelo déficit da raiz que some ao excluí-lo |
| `peel` | condição de parada: o resíduo da raiz deixou de ser material |
| supressão de eco | testa os demais candidatos com a causa recortada |

O teste residual não é um passo tardio: é a função de pontuação. Um nó eco tem
déficit explicado próximo de zero assim que a causa real sai da conta.

---

## 4. Algoritmo

### 4.1 Busca

Raiz fixa merchant × país (DD17). Dimensões livres: provider, método, emissor.
O esperado de cada filho é o **corte transversal contra os irmãos**
(`crossSectionalExpected`), nunca a constante do merchant — a regra de
`context/schema.md` §6. A cobertura de roteamento é respeitada, e o emissor só é
dividido quando a fatia já não carrega tráfego PIX, porque linhas de PIX levam
emissor `NA`.

Um candidato é admissível quando tem queda material pelo intervalo de Wilson e
excluí-lo reduz estritamente o déficit da raiz. Não há limiar de fração
explicada: quem termina a busca é o resíduo.

### 4.2 Seleção

Densidade primeiro, magnitude depois, parcimônia por último. A justificativa e as
alternativas descartadas estão em
`flight_logs/diagnosis_by_deficit_density.md`.

### 4.3 Peeling

A cada volta: busca sobre o déficit ainda inexplicado, escolhe a causa, grava os
ecos suprimidos e acrescenta a célula ao conjunto de exclusão. Termina quando o
resíduo deixa de ser material (DD18).

### 4.4 Mistura de recusas

Deslocamento do share por código contra `decline_codes.baseline_share`, com o mix
da própria célula assumindo quando ela tem histórico suficiente. A janela alarga
de 1 para 5 e 15 minutos até somar recusas suficientes para ler. `91` e `AB03`
são desambiguados pela dispersão. Ver
`flight_logs/decline_mix_catalogue_reference.md`.

### 4.5 Custo e prioridade

Acumulado de `started_at` — varredura retroativa reusada de
`detect/onset-scan.ts` (DD8) — até a janela de detecção. Aprovações perdidas com
`ci_high`, custo em USD e na moeda local, e `priority_score` igual ao custo por
minuto. Ver `flight_logs/priority_by_conservative_cost.md`.

### 4.6 Evidência insuficiente

Raiz materialmente caída e nenhum filho destoando dos irmãos produz um
diagnóstico com `confidence: "INCONCLUSIVE"` sobre a própria raiz, em vez de
promover a célula menos inocente. É o bônus de `context/spec.md` §5, e é o que
acontece na degradação global e simultânea, o caso que o gatilho absoluto existe
para pegar.

---

## 5. Testes

Todos determinísticos, com fixtures calculadas à mão (`context/rules.md` §4).
21 testes em 7 arquivos.

| Arquivo | Cobre |
|---|---|
| `residual.test.ts` | uma causa mais ecos: o resíduo limpa para os ecos, não para a causa |
| `beam-search.test.ts` | célula causal em profundidade 3; guarda semântica do PIX; raiz saudável |
| `parsimony.test.ts` | densidade vence diluição; empate estrutural PIX implica BR; emissor mexicano |
| `peeling.test.ts` | dois incidentes simultâneos sob a mesma raiz; parada; eco suprimido |
| `decline-mix.test.ts` | `05` de 32% para 78%; alargamento no PIX; referência temporal; as três leituras do `91` |
| `cost.test.ts` | ponta conservadora e não a taxa observada; acumulado e por minuto |
| `run.test.ts` | os dois cenários obrigatórios juntos, ordenados por dinheiro; evidência insuficiente |

---

## 6. Decisões e lacunas conhecidas

Registradas aqui para não serem descobertas na sabatina.

| # | Lacuna | Consequência / mitigação |
|---|---|---|
| D1 | Sem banco: `diagnose/` é puro sobre arrays | Mesmo recorte do detector. A branch de camada SQL implementa `RollupSource` e alimenta `runDiagnosis`. |
| D2 | Sem objeto de evidência nem contrato de handoff | Adiado por decisão do usuário. `Diagnosis` vive em `diagnose/run.ts`, não em `contracts`. Promovê-lo é o primeiro passo da branch do agente. |
| D3 | Célula alcançável por dois caminhos guarda a primeira leitura de esperado | O esperado transversal depende do conjunto de irmãos, que depende do caminho percorrido. A deduplicação por célula mantém a primeira leitura, logo a ordem de expansão do beam influencia o resultado em tese. Não foi possível construir um caso em que isso troque a resposta: para um provider superar o emissor no ranking ele precisa estar amplamente ruim, e nesse caso o emissor deixa de destoar dentro dele. Declarado em vez de corrigido com máquina não testável (`context/rules.md` §1, YAGNI). |
| D4 | `TEMPORAL_MIN_DECLINES = 100` sem derivação formal | Escolha de prudência. `MIN_DECLINES = 20` tem justificativa direta: abaixo disso uma única recusa move o share em mais de 5pp. |
| D5 | Ticket médio é a média da célula na janela, não a distribuição | O custo não discrimina a cauda de valor dentro da fatia. |
| D6 | Sem casamento de playbook | `causalDimension` e a família do código dominante já saem prontos para o matcher da branch seguinte. |
| D7 | `MAX_INCIDENTS_PER_ROOT = 3` | Guarda contra laço patológico; a parada real é o resíduo. Uma raiz com mais de três causas simultâneas reportaria só as três mais densas. |
