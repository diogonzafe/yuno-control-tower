---
title: "Flight log — Taxa de conversão por merchant fixada"
---

# Taxa de conversão por merchant fixada

**Decisão travada:** DD7. Supersede a decisão D3 do documento de decisões anterior.

## Opções consideradas

- **Baseline sazonal aprendido** — taxa esperada por hora do dia / dia da semana,
  sintetizada de ~6 semanas de histórico (tabelas `baseline_profile`,
  `rollup_hour`, relógio híbrido no boot, módulo `engine/baseline/`).
- **Modelo de série temporal / previsão** para o esperado.
- **Constante configurada por merchant** (`merchants.expected_conversion`), sem
  aprendizado.

## O que escolhemos

Constante por merchant, comparada **somente** contra o agregado do merchant,
nunca contra uma célula. O esperado de cada célula vem em tempo real do corte
transversal contra os irmãos (primário) e do corte temporal das últimas 2–6h no
`rollup_minute` (secundário). A constante é apenas o gatilho absoluto para o caso
de degradação global e simultânea, em que ninguém destoa de ninguém.

## Por quê

- Elimina duas tabelas, uma etapa inteira do pipeline e a síntese de 6 semanas de
  histórico — economia grande e defensável em 24h.
- Sem warm-up: basta uma janela curta de operação normal antes da primeira injeção.
- Um único parâmetro a justificar na sabatina (confiança 95%), sem força de prior.
- Premissa que impõe ao gerador, a declarar: a **taxa** de conversão é
  estacionária no tempo; só o **volume** é sazonal. O ruído de madrugada fica
  coberto pelo intervalo de Wilson largo, não pelo baseline.
