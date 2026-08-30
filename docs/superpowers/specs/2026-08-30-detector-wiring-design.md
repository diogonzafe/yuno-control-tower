---
title: "The Control Tower — Detector wiring design (RollupSource + scheduler + API)"
doc_id: "YCT-WIRE-001"
doc_related:
  - "YCT-DETECT-001"
  - "YCT-RULES-001"
  - "YCT-AGENTS-001"
  - "YCT-ING-001"
  - "context/roadmap.md"
domain: "detection-runtime"
dimension_schema: ["merchant", "provider", "country", "payment_method", "issuer"]
time: "2026-08-30T05:30:00Z"
---

# Detector wiring design

Connects the detection engine — today complete, tested, and **mute** — to
the real database and to an HTTP/SSE API. This is the debt from the
H+3→H+7 phase of `context/roadmap.md`: `context/detector.md` §1.2 explicitly
delegates "Scheduler / per-minute tick / Fastify wiring / SSE" and
"`RollupSource` implementation" to this branch.

Without it, acceptance criteria 1 and 2 of `context/spec.md` §4 are not
demonstrable, even with correct logic.

## Context

Done and out of scope for this branch:

- `packages/app/src/detect/*` — `runDetectionTick(input): TickOutput`, a pure
  function, 100% tested with in-memory fixtures. Doesn't touch the database.
- `packages/app/src/db/client.ts` — `db` (Drizzle) and `sql` (postgres.js).
- `packages/app/src/ingest/*` — full ingestion, populating `rollup_minute`.
- `packages/contracts` — `ConfirmedDrop`, `EvidenceGap`, `EvidenceObject`.

Out of scope, and staying out: `diagnose/`, `orchestrate/`, `agent/`, UI.

## Decisions made during the brainstorm

| Decision | Choice | Why |
|---|---|---|
| Destination of signals | In-memory buffer + SSE + REST | `orchestrate/` is the one that writes to `incidents` (`detector.md` §1.2). Writing here would encroach on its scope and create a conflict. |
| Processes | Ingest + scheduler + API in a single process | `rules.md` §6.2 is explicit: `app` "consumes the stream, runs rollup + detector, and serves REST/SSE." Today ingest has a separate entrypoint — this branch fixes that. |
| API surface | SSE + signals + gaps + conversion series | Covers the first 3 screens of the minimum viable UI (`roadmap.md` §281). |
| Tick trigger | 60s timer with a query per tick | Independent of ingest: if ingestion dies, the detector keeps running and the silence becomes **visible**, instead of looking like health. |

Alternatives discarded for the trigger: **tick triggered by ingest** (data
guaranteed complete, but a stuck ingest = a mute detector, indistinguishable
from "everything is fine" — the worst failure mode in a demo); **in-memory
history cache** (90 cells × 120 min ≈ 10 thousand rows per tick is trivial
for Postgres; caching would be premature optimization, `rules.md` §1).

## Architecture

```
packages/app/src/
├── db/queries.ts          # implements RollupSource + loads merchants/coverage
├── detect/scheduler.ts    # 60s loop: load → runDetectionTick → deliver
├── api/
│   ├── signal-store.ts    # ring buffer of signals and gaps
│   ├── sse.ts             # broadcast, no library
│   ├── routes.ts          # REST
│   └── server.ts          # assembles Fastify
└── run.ts                 # single entrypoint: ingest + scheduler + server
```

`detect/scheduler.ts` lives in `detect/` because it is detection runtime;
`api/` stays exclusively about HTTP.

## Data layer (`db/queries.ts`)

Three functions, all with **typed** Drizzle — not raw `db.execute`. These are
simple selects, not the cube's dynamic `GROUP BY` queries; raw SQL stays
reserved for `diagnose/`, as `rules.md` §6.3.1 dictates. This also eliminates
the §6.8 risk for free: `amountUsdSum`/`approvedUsdSum` are
`bigint({ mode: "number" })` and come back as `number`.

- `getWindowRollups(bucket)` / `getHistory(from, to)` — implement the
  `RollupSource` interface already declared in the file.
- `loadMerchantConfigs()` — **trap:** `expectedConversion` and
  `minMaterialDropPp` are `numeric` with no explicit mode, so Drizzle returns
  a **string**. They require an explicit `Number()`; without it Wilson
  compares a number to a string and the detector silently never fires.
- `loadRoutingCoverage()` — the 12 rows from DD13.

`rollup_minute.bucket` is `timestamp` (comes back as a `Date`), but
`RollupRow.bucket` is an ISO `string`. The conversion happens once, at the
SQL boundary, so the pure engine receives exactly the shape its tests already
use.

## Scheduler (`detect/scheduler.ts`)

Every 60 seconds:

1. **Target** = `floorToMinute(now − 10s) − 1min`. The 10s slack absorbs
   ingest lag; the `floor` plus the comparison against the last processed
   bucket makes the calculation immune to `setInterval` drift and to
   duplicate firings. The 10s cost 10 seconds of latency, irrelevant against
   the 3 minutes the persistence rule already imposes.
2. **Catch-up capped at 10 buckets.** If buckets were skipped, it processes
   from last+1 up to the target, in order. This matters: skipping a bucket
   would break the count of 3 consecutive windows and the incident would
   never confirm. On boot (no last bucket), it processes **only the most
   recent one** — no 2h backfill, which would fire stale signals at
   startup.
3. Loads `windowRows`, `history` (120 min, `ONSET_LOOKBACK_MIN`), `merchants`,
   and `coverage`. Four queries per tick; the catalogs are reloaded every
   tick on purpose — 21 rows total, and caching would raise the invalidation
   question with no measurable savings.
4. Calls `runDetectionTick`.
5. Delivers `signals` and `evidenceGaps` to the store and to SSE; keeps
   `nextState`.

**`PersistenceState` stays in memory.** `detector.md` §9 explicitly allows
this ("process memory or a table"). Declared cost: restarting the process
resets the sequences, so an in-progress incident takes another 3 minutes to
reconfirm. Acceptable, and it avoids a table + migration that
`orchestrate/` will likely want to design its own way.

## API

**SSE** (`api/sse.ts`), no library (`rules.md` §6.1): writes directly to
`reply.raw` with `text/event-stream` headers, keeps a `Set` of connections,
removes on `close`, and sends a `: keepalive` comment every 20s so it doesn't
die behind a proxy. Events: `signal` and `evidence-gap`.

| Route | What |
|---|---|
| `GET /health` | ingest state, last tick, last bucket, `bucketLagMinutes`, open connections |
| `GET /api/signals?limit=` | `ConfirmedDrop[]` from the buffer, newest first |
| `GET /api/evidence-gaps?limit=` | `EvidenceGap[]` — the "admits it doesn't know" bonus (`spec.md` §5) |
| `GET /api/conversion?from=&to=&<dims>` | time series for the live chart |
| `GET /api/stream` | SSE |

`/api/conversion` **reuses `aggregateByBucket` from `detect/aggregate.ts`**
instead of writing a new aggregation — it's literally what `rules.md` §1
requires ("the three rollup reads use the same aggregation function with
different parameters, not three implementations").

The buffer is a ring capped at 200 signals and 200 gaps.

## Errors and observability

**Tick failure:** the scheduler never dies. It catches, logs at `error`, and
**does not advance** the cursor — the next minute's catch-up tries again. If
the failure persists, the 10-bucket cap makes the detector fall behind, and
`/health` tells the truth via `bucketLagMinutes`. It is deliberate to fail
**visibly** (growing lag) instead of silently (skipping buckets).

**Declared consequence of merging the processes:** the ingest consumer calls
`process.exit(1)` after 5 database retries. In the single-process setup this
takes the API down with it. Kept as-is by explicit choice during the
brainstorm. Since it's the same database the detector uses, it would be
inoperative anyway; what's lost is the API's ability to *report* the
failure.

**SSE:** writing to a dead socket throws — every `write` is guarded and the
connection is removed from the `Set`, without taking down the broadcast for
the others.

## Tests

Writing order (TDD, `rules.md` §4 — deterministic first):

1. **`scheduler.test.ts`** — pure logic, with an injected clock and
   `RollupSource`, no timer and no database: target-bucket calculation
   (slack, drift, duplicate firing), catch-up capped at 10, boot processing
   only the most recent one, and a tick failure not advancing the cursor.
2. **`signal-store.test.ts`** — ring cap, order (newest first), `limit`.
3. **`sse.test.ts`** — wire format (`event:` + `data:` + blank line), dead
   connection removed without throwing.
4. **`routes.test.ts`** — via Fastify's `app.inject()`, same pattern as the
   generator's injection API tests. Fake source, no database.
5. **`queries.integration.test.ts`** — the **only** one that needs the real
   database, and the most important: verifies that `expectedConversion`
   comes back as a `number`, not a `string`, and that `bucket` turns into
   ISO. This is where the silent failure described above lives.

**Manual verification, at the end:** bring up the single process, inject an
incident through the generator's API, and watch the `signal` arrive on SSE
within ~3 minutes (3-window persistence). This is the first time the system
works end to end.

## Out of scope

Writing to `incidents`, fingerprinting with the dominant decline, lifecycle,
memory/pgvector (`orchestrate/`); residual test, beam search, peeling, cost,
priority (`diagnose/`); narrator and tools (`agent/`); any UI component. The
`EvidenceObject` is not assembled here — `diagnose/evidence.ts` assembles it,
per `flight_logs/who_assembles_the_evidence_object.md`.
