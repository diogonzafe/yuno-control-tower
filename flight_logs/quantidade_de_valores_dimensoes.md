---
title: "Flight log — Definição de Quantidade de Valores Das Dimensões"
---

# Definição de Quantidade de Valores Das Dimensões

**Decisões travadas:** DD4, DD5, DD6, DD12, DD13, DD14.

## Opções consideradas

- **Cobertura de roteamento irregular** (realista: nem todo provider atende todo
  país/método).
- **Terceiro método** (wallet) além de cartão e PIX.
- **Malha completa** provider × país, com poucos valores fixos por dimensão.

## O que escolhemos

- Países: **AR, MX, BR** (DD4).
- Métodos: **cartão e PIX**; PIX só existe no BR (DD5).
- Providers: **Stripe, Adyen, Mercado Pago**, sem comportamento diferenciado (DD6).
- Emissores: **3 por país** (DD13).
- **Malha completa** provider × país; `routing_coverage` com 12 linhas (DD13).
- Total: **90 células** (81 de cartão + 9 de PIX).
- Bucket de **1 min**, `min_volume = 30`, `δ = 3pp`, gerador a **~60 TPS** com
  distribuição desigual (DD14).
- Cubo = as **6 dimensões** do enunciado; `card_brand` e `card_type` ficam em
  `transactions` mas fora do cubo (DD12).

## Por quê

- Cubo denso: toda célula tem irmãos para o corte transversal e o teste residual.
- Mais combinações válidas para o júri atacar no trial by fire.
- `routing_coverage` explícita elimina uma classe inteira de falso positivo
  (célula inexistente ≠ volume zero).
- Perde-se realismo (cobertura real é irregular); troca aceita para 24h.
- Restrição conhecida: `PIX ⇒ BR`, então `payment_method` é constante em AR/MX e a
  busca não desce por essa dimensão nesses países.
