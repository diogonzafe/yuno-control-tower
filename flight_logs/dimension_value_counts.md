---
title: "Flight log — Defining the number of values for each dimension"
---

# Defining the number of values for each dimension

**Locked decisions:** DD4, DD5, DD6, DD12, DD13, DD14.

## Options considered

- **Irregular routing coverage** (realistic: not every provider serves every
  country/method).
- **A third method** (wallet) beyond card and PIX.
- **Full mesh** provider × country, with few fixed values per dimension.

## What we chose

- Countries: **AR, MX, BR** (DD4).
- Methods: **card and PIX**; PIX exists only in BR (DD5).
- Providers: **Stripe, Adyen, Mercado Pago**, with no differentiated behavior (DD6).
- Issuers: **3 per country** (DD13).
- **Full mesh** provider × country; `routing_coverage` with 12 rows (DD13).
- Total: **90 cells** (81 card + 9 PIX).
- **1-min** bucket, `min_volume = 30`, `δ = 3pp`, generator at **~60 TPS** with an
  uneven distribution (DD14).
- Cube = the **6 dimensions** from the brief; `card_brand` and `card_type` stay in
  `transactions` but outside the cube (DD12).

## Why

- Dense cube: every cell has siblings for the transverse cut and the residual test.
- More valid combinations for the jury to attack in the trial by fire.
- An explicit `routing_coverage` eliminates a whole class of false positive
  (nonexistent cell ≠ zero volume).
- We lose some realism (real coverage is irregular); an accepted trade for 24h.
- Known constraint: `PIX ⇒ BR`, so `payment_method` is constant in AR/MX and the
  search does not descend along that dimension in those countries.
