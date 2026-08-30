---
title: "Flight log — Quem monta o EvidenceObject"
---

# Quem monta o EvidenceObject

**Fixa um contrato de dados público** (`EvidenceObject` em
`packages/contracts/src/incident.ts`) e a fronteira entre `diagnose/`,
`agent/` e `orchestrate/`. Os documentos definiam quem **consome** o objeto
(o narrador, seis vezes: `roadmap.md` §1/§2, `rules.md` §3/§4/§6.4.1,
`AGENTS.md`), mas nunca quem o **monta** — `context/detector.md` §9 apenas
dizia que a coluna `incidents.evidence` é preenchida por "`diagnose/`,
`agent/` e `orchestrate/`", sem separar qual.

## Opções consideradas

- **O agente monta.** O investigador termina a exploração e monta o objeto com
  o que descobriu, já que é ele quem tem a trilha na mão.
- **`orchestrate/` monta.** Como é ele quem escreve em `incidents`, também
  seria ele a juntar as peças vindas do detector e de `diagnose/`.
- **`diagnose/` monta**, numa função pura `buildEvidence(signal, diagnosis,
  trail?)`, e tanto o caminho agêntico quanto o beam-search determinístico
  terminam nela.

## O que escolhemos

`diagnose/evidence.ts` monta o `EvidenceObject`, deterministicamente. O
agente nunca monta — ele só produz a trilha, que entra como argumento
opcional. `orchestrate/` recebe o objeto pronto, persiste verbatim em
`incidents.evidence` e cuida do ciclo de vida, sem inspecionar o conteúdo. O
narrador consome o objeto fechado e não pode citar número ausente dele.

O tipo carrega `diagnosisSource: "agent" | "beam_search"`, então a própria
evidência registra por qual caminho o diagnóstico chegou.

## Por quê

- **A fronteira #3 de `rules.md` §3 decide sozinha.** Todo caminho agêntico
  tem fallback determinístico: se o agente montasse o objeto, quando ele
  falhasse ou estourasse o timeout, o beam-search precisaria montar de novo —
  duas implementações do mesmo objeto, divergindo na primeira mudança de
  regra. É exatamente o bug que o princípio DRY de `rules.md` §1 descreve.
- **Os números já são de `diagnose/`**: célula causal e ecos suprimidos (teste
  residual), deslocamento do decline-mix, custo por minuto, prioridade. Montar
  em `orchestrate/` obrigaria `diagnose/` a devolver um saco de peças para
  outro módulo remontar — camada de tradução sem ganho.
- **Torna obrigatório e barato o teste que `rules.md` §4 exige do narrador**
  ("o texto não contém nenhum número ausente do objeto"): com o objeto sendo
  saída determinística, o teste roda sobre fixture fixa, sem tocar em LLM.
- **Custo assumido:** `diagnose/` fica com uma responsabilidade a mais além de
  calcular — ele também formata o contrato de saída. Aceito porque a
  alternativa (um módulo `evidence/` separado só para empacotar) adiciona uma
  fronteira a mais para atravessar sem remover nenhuma duplicação, e porque a
  montagem é uma função pura testável isoladamente, não lógica de negócio nova.
- **Consequência a declarar na sabatina:** o sistema produz evidência completa
  e auditável mesmo com a camada agêntica inteira desligada — `diagnosisSource`
  no próprio objeto é a prova de que o fallback rodou.
