# The detector's state (confirmed signals, `PersistenceState`) lives in process memory, never in `incidents`, and the tick fires on a timer, not on ingest

**Decisions:** three choices from the same family, all in
`packages/app/src/detect/scheduler.ts` and `packages/app/src/api/signal-store.ts`.
Full spec in
`docs/superpowers/specs/2026-08-30-detector-wiring-design.md` ("Decisions made in
the brainstorm" and the "Scheduler" section).

## Options considered

**Destination of the confirmed `ConfirmedDrop`/`EvidenceGap`:**

- **Write to `incidents`** — joins detection, fingerprint, lifecycle, and memory
  (pgvector) in a single module; invades the scope that `detector.md` §1.2/§9
  explicitly reserves for `orchestrate/` (a following branch, still outside this
  one).
- **In-memory buffer (ring of 200) + SSE** — the detector emits and forgets;
  whoever wants to persist / manage lifecycle is the orchestrator.

**Where `PersistenceState` lives (the counter for the 3 consecutive windows):**

- **A table in Postgres** — survives a restart, but requires designing a schema
  and migration for a structure that `orchestrate/` will probably want to
  redesign its own way when `incidents` exists.
- **Process memory** (a `Map` in the `createScheduler` closure) — `detector.md` §9
  explicitly allows both options ("process memory or a table... returns it on the
  next tick").

**Trigger for the detection tick:**

- **Fired by the ingest** (on every micro-batch written) — data guaranteed to be
  complete at the moment of firing.
- **A 60s timer, independent of the ingest**, with its own query per tick.

## What we chose

- Confirmed signals and evidence gaps live only in memory: a ring buffer of 200
  entries (`api/signal-store.ts`) and an SSE broadcast (`api/sse.ts`). Nothing is
  written to `incidents`.
- `PersistenceState` is a `Map` closed over the scope of `createScheduler`
  (`detect/scheduler.ts`), passed from tick to tick as `prevState`/`nextState` —
  never touching the database.
- The tick runs on `setInterval(..., 60_000)` (`startScheduler`), with its own
  load of `windowRows`/`history`/`merchants`/`coverage` on each firing, decoupled
  from when (or whether) the ingest wrote anything in that minute.

## Why

- `orchestrate/` is the one that writes to `incidents` (`detector.md` §1.2, §9).
  Writing here would duplicate that responsibility and create two owners for the
  same row — exactly the kind of boundary the technical Q&A probes ("why don't you
  persist the detected incidents?"): the answer is that this branch ends at the
  typed signal; persistence, fingerprint with dominant decline, and lifecycle are
  the next one.
- Memory for `PersistenceState` avoids a table + migration whose final format
  depends on decisions not yet made in `orchestrate/` (lifecycle, fingerprint).
  `detector.md` §9 already covers both options as valid.
- A timer decoupled from the ingest is deliberate: if ingestion stalls, the
  detector keeps running and the absence of new data shows up as visible lag in
  `bucketLagMinutes` on `/health` — **visible** silence. A tick fired by the
  ingest would go mute along with it, which in a demo is indistinguishable from
  "all is well", the worst possible failure mode.

**Cost of each choice:**

- **No incident persistence in this branch:** there is no incident history
  surviving a restart, nor a screen listing past incidents — only what is in the
  current ring buffer. Left to `orchestrate/`.
- **`PersistenceState` in memory:** a process restart zeroes all the
  consecutive-window counters. An incident that already had 2 of the 3 windows
  confirmed loses the progress and needs another full 3 minutes to reconfirm from
  scratch. It happens every time the process restarts (deploy, crash,
  `SIGINT`/`SIGTERM`), not only in rare failures.
- **60s timer independent of the ingest:** each tick runs its own query even if
  nothing has changed since the previous tick — `merchants` and `coverage` are
  reloaded on every firing on purpose (21 rows in total; caching would be
  premature optimization, `rules.md` §1). Against a healthy ingestion this is 4
  queries per minute spent for nothing; the benefit is precisely not trusting the
  ingest to know whether it is alive.
