---
title: "Flight log — Synchronous transactions"
---

# Synchronous transactions

**Locked decisions:** DD2 (everything synchronous) and DD1 (no retry).

## Options considered

- **Asynchronous lifecycle** — `PENDING` state, later status-update event, attempt
  retry.
- **Everything synchronous** — final status (`SUCCESS` / `DECLINED`) at the
  instant of the event; PIX modeled as immediate approval.

## What we chose

Everything synchronous. 1 order = 1 attempt, no retry, no `PENDING`, no update
event. `transaction_id` and `merchant_order_id` stay 1:1.

## Why

- Conversion becomes `approved / attempts` in the cell — it simplifies the entire
  cube and the two rollup tables.
- Removes state and an event path that add nothing to the diagnosis within the
  24h window.
- It is a conscious simplification (real PIX has asynchronous confirmation),
  recorded here in the decision log.
