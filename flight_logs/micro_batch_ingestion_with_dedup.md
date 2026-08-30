---
title: "Flight log — Micro-batch ingestion with deduplication via RETURNING"
---

# Micro-batch ingestion with deduplication via RETURNING

## Options considered

- **Message by message** (`XREADGROUP COUNT 1`): insert into `transactions` +
  upsert of the two rollups per event, one Postgres transaction per event.
- **Micro-batch** (`XREADGROUP COUNT ~100 BLOCK 500ms`): batch insert with
  `ON CONFLICT (transaction_id) DO NOTHING RETURNING`, in-memory aggregation of
  the rollup deltas computed only from the returned rows, one upsert per rollup
  table, all in a single Postgres transaction, `XACK` of the whole batch only
  after the commit.
- **Buffer with time/size flush** decoupled from the read size (double buffering),
  to smooth the write even further.

## What we chose

Micro-batch with deduplication via `RETURNING`.

## Why

- At 60 TPS, message by message means up to ~180 round-trips/s to Postgres
  (insert + up to two upserts per event) — the antipattern that `rules.md` §6.8
  already flagged as a risk of stalling the event loop ("one query per cell in
  series, and the SSE stalls").
- The `RETURNING` of `ON CONFLICT DO NOTHING` solves consumer-group redelivery for
  free: if the process dies between the insert and the `XACK`, reprocessing the
  same batch produces an empty `RETURNING` for the rows already committed, and the
  rollup delta computed from it is zero — no separate deduplication table, no
  hand-written idempotent counter.
- A buffer with a decoupled flush (third option) solves a write-smoothing problem
  that does not exist at 60 TPS — complexity with no return, against the YAGNI of
  `rules.md` §1.
- **Accepted cost:** the per-batch in-memory aggregation function
  (`aggregateDeltas`) is more code and more test surface than the naive
  message-by-message path. Accepted because it is the same piece that the
  transverse cut and the retroactive scan will reuse later — it is not
  single-use code.
