---
title: "Flight log — Fixed expected conversion per merchant"
---

# Fixed expected conversion per merchant

**Locked decision:** DD7. Supersedes decision D3 from the previous decisions
document.

## Options considered

- **Learned seasonal baseline** — expected rate per hour of day / day of week,
  synthesized from ~6 weeks of history (tables `baseline_profile`, `rollup_hour`,
  hybrid clock at boot, module `engine/baseline/`).
- **Time-series / forecasting model** for the expected value.
- **Constant configured per merchant** (`merchants.expected_conversion`), with no
  learning.

## What we chose

A per-merchant constant, compared **only** against the merchant aggregate, never
against a cell. Each cell's expected value comes in real time from the transverse
cut against its siblings (primary) and from the temporal cut over the last 2–6h
in `rollup_minute` (secondary). The constant is only the absolute trigger for the
case of global, simultaneous degradation, where no one stands out from anyone else.

## Why

- Eliminates two tables, a whole pipeline stage, and the synthesis of 6 weeks of
  history — a large, defensible saving in 24h.
- No warm-up: a short window of normal operation before the first injection is
  enough.
- A single parameter to justify in the technical Q&A (95% confidence), with no
  prior strength.
- An assumption it imposes on the generator, to be declared: the conversion
  **rate** is stationary over time; only **volume** is seasonal. Overnight noise
  is covered by the wide Wilson interval, not by the baseline.
