# Detector usa intervalo de Wilson; a saída é o contrato `ConfirmedDrop`, sem tocar em `incidents`

**Decisões:** confirma DD11 (Wilson, já refletido em `context/schema.md` v3+).
Fixa o contrato de saída do detector e a fronteira determinística do motor de
detecção. Spec completo em `context/detector.md` (`YCT-DETECT-001`).

## Opções consideradas

**Estatística do teste por célula:**

- **Beta-binomial bayesiano** — precisa de um parâmetro de força de prior para
  calibrar e justificar na sabatina; sem biblioteca fechada em TS.
- **z-test de proporções / qui-quadrado** — clássico, mas exige controlar
  múltiplas comparações à mão sobre milhares de células, e não entrega um
  intervalo legível para a UI.
- **Intervalo de Wilson** — fórmula fechada (~8 linhas), sem dependência, sem
  prior; o único parâmetro é o nível de confiança (95%, `z = 1.96`). O intervalo
  é exatamente o visual de evidência que a tela mostra.

**Fronteira da saída do detector:**

- **Detector escreve em `incidents`** — junta detecção, dedup por fingerprint,
  ciclo de vida e memória num módulo só; puxa banco, `docker-compose` e pgvector
  para dentro da frente de estatística.
- **Detector emite um sinal tipado em memória e para** — o orquestrador
  (determinístico, branch seguinte) persiste e gerencia a linha de `incidents`.

**Escopo da varredura transversal de profundidade 1:**

- **A partir da raiz global** (letra de `context/roadmap.md` §2, "filhos da
  raiz").
- **A partir de cada `merchant × país`**, dividindo por provider, emissor e
  método.

## O que escolhemos

- **Wilson**, `z = 1.96`, com persistência de **3 janelas consecutivas** em
  `MATERIAL_DROP` para confirmar. `evaluate()` devolve 4 estados
  (`MATERIAL_DROP`, `HEALTHY`, `MONITORING`, `INSUFFICIENT_EVIDENCE`); o detector
  só age no primeiro, persistente.
- **Núcleo determinístico DB-agnóstico**: os módulos de `packages/app/src/detect/`
  são funções puras que recebem `RollupRow[]`. `db/queries.ts` fica só como a
  interface `RollupSource`; o SQL do cubo e a ingestão são branches seguintes.
- O detector emite **`ConfirmedDrop`** (Zod, `packages/contracts/src/incident.ts`)
  já com `ci_low`/`ci_high`, `current_rate`, `baseline_rate`,
  `started_at`/`started_at_exact` calculados. Também emite **`EvidenceGap`** para
  fatias sem volume — o bônus "admite que não sabe" do `context/spec.md` §5.
  Nada de `incidents`, custo, `priority_score`, decline-mix, teste residual ou
  LLM nesta branch.
- **Varredura transversal com raiz em `merchant × país`.**

## Por quê

- Wilson tira o parâmetro de prior da mesa (uma peça a menos na defesa técnica),
  não tem dependência, e o intervalo vira a evidência visual direta. O ruído de
  madrugada fica coberto pelo intervalo largo em baixo volume, não por baseline
  sazonal (coerente com DD7 / `taxa_de_conversao_fixada.md`).
- `context/schema.md` v3 já dizia "sai o beta-binomial em favor do intervalo de
  Wilson (DD11)", e `roadmap.md` e `rules.md` §6.6 já traziam Wilson. Só o
  `AGENTS.md` mantinha uma nota de conflito obsoleta ("DD11 especifica
  beta-binomial ... não implemente até confirmar"). Este flight log fecha a
  divergência; o commit da branch corrige o `AGENTS.md`.
- Separar o detector do orquestrador mantém a frente de estatística sem banco,
  como o `roadmap.md` §5/§6 sequencia (`F0 → F1 → F2`), e deixa a interface entre
  os dois pequena e testável (`ConfirmedDrop`).
- A varredura a partir da raiz global não pega "emissor X cai só para o merchant
  M" — a taxa global de X entre os 3 merchants pode seguir saudável — e esse é
  metade do caso mínimo obrigatório do `context/spec.md` §4. Rodar dentro de
  `merchant × país` cobre os dois cenários por construção.

**Custo de cada escolha:**

- **DB-agnóstico:** a branch não roda ponta a ponta. Precisa de uma branch
  seguinte para `db/client.ts`, o SQL cru do cubo e a implementação de
  `RollupSource`, e de outra para a ingestão, antes de haver demo.
- **Sem teste residual aqui:** o tick pode emitir tanto `{merchant, país}`
  (gatilho absoluto) quanto `{merchant, país, +dim}` (transversal) para a mesma
  causa. A supressão de sombra fica para `diagnose/residual.ts` + orquestrador; o
  `ConfirmedDrop` já carrega o que o teste residual precisa.
- **Raiz em `merchant × país`:** diverge da redação de `roadmap.md` §2. Alinhado
  no mesmo commit com um ponteiro em `context/schema.md` §6; o exemplo narrado do
  roadmap fica como está.
- **`MONITORING` sem ação:** o estado existe em `evaluate()` e nos testes por
  fidelidade a `schema.md` §6.3, mas nunca vira sinal — uma sutileza a explicar
  se um juiz perguntar.
