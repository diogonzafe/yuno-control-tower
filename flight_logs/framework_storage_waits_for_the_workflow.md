# Mastra storage waits for the workflow that needs it

## Options considered

- Configure `PostgresStore` on the Mastra root in phase 1, as the design
  originally fixed (DD: `@mastra/pg` added with the root), so the store is in
  place before the phase-4 workflow needs it to suspend and resume.
- Configure it in phase 1 but point the test environment at a throwaway
  database, or set `disableInit: true` so the store skips table creation.
- Give every suite that transitively reaches the narrator an injected agent, so
  none of them constructs the root.
- Leave the root storage-less until the phase that actually reads and writes it.

## What we chose

The Mastra root carries agents only. `PostgresStore` and the
`@mastra/observability` tracing exporter that writes into it both move to phase
4, alongside the workflow that suspends for the human decision. `@mastra/pg` was
added and then removed inside the same task; phase 1 adds no production
dependency at all.

## Why

Measured on 2026-09-10, with the store configured on the root: any test suite
without agent injection reaches `getMastra()` through `renderNarratives`, and
constructing the store runs `PostgresStore.init()` — real DDL against the
product's own database. Two suites that had been passing broke, and one run
produced a Postgres deadlock on concurrent `ALTER TABLE`. Unit tests migrating
schema in the product database is a worse failure than any it was preventing.

Making the root lazy narrowed the blast radius but did not remove it, because
the narrator path constructs the root on demand. Pointing tests at a throwaway
database or disabling init would have hidden the symptom while leaving a store
that nothing in the phase reads or writes — phase 1 has no workflow, nothing
suspends, nothing resumes. AGENTS.md forbids exactly that: "Do not implement
speculative infrastructure or YAGNI items." Injecting agents into every affected
suite would have meant redesigning `orchestrate/coordinator.ts`, which phase 2
deletes outright.

The cost is real. Phase 4 now pays for wiring the store instead of inheriting
it, and phase 1 never proves the store is reachable from this deployment — a
connection or permission problem will surface later than it would have. The
decision that `@mastra/pg` is the right store, on the product's existing
Postgres in framework-owned tables and never the source of truth for incidents
or audit, is unchanged and still stands; only its arrival moved.
