---
title: "Flight log — USD as the default currency but with a local-currency record"
---

# USD as the default currency but with a local-currency record

**Locked decisions:** DD3 (local currency + USD normalization) and DD9 (FX at the
market standard).

## Options considered

- **USD only** on the transaction.
- **Local currency only**, recomputing USD on demand with the current rate.
- **Intraday quote**, transaction by transaction.
- **Local + normalized USD**, with rate/date/source frozen on the transaction and
  one reference rate per currency per day.

## What we chose

The market accounting standard. Every transaction records `amount_minor` (local),
`amount_usd_minor` (derived, frozen at creation), `fx_rate`, `fx_rate_date`, and
`fx_source`. `fx_rates` is a per-date series; one reference rate per currency,
fixed at the start of the day, holds from 00:00 to 23:59. Incident cost is
reported per country in local currency and in USD for the global priority
ranking — both readings come from the same row, with nothing recomputed.

## Why

- Audit: the cost of yesterday's incident is always measured with yesterday's
  dollar, regardless of what the FX table contains today. **Never recompute
  historical USD.**
- Reconciliation: payment processors do not convert transaction by transaction
  with an intraday quote.
- It matters more with ARS than with BRL or MXN.
- For the demo, `fx_source = 'MOCK'` is acceptable as long as it is declared
  (real references: PTAX/BCB, DOF/Banxico, Comunicación A3500/BCRA).
