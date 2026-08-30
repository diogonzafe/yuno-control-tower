---
title: "Flight log — Managed Postgres and Redis in the cloud, no docker-compose"
---

# Managed Postgres and Redis in the cloud, no docker-compose

## Options considered

- **Local `docker-compose.yml`** — Postgres+pgvector and Redis running in
  containers on each member's machine, as originally described in `rules.md`
  §6.3/§6.7.
- **Managed cloud services** (Railway) — a Postgres with the `vector` extension
  available and a Redis already provisioned, with a single
  `DATABASE_URL`/`REDIS_URL` shared by the team via `.env`.

## What we chose

Managed cloud services. There is no `docker-compose.yml` in the repository;
`context/rules.md` §6.7 ("Bringing up the environment") describes the docker flow
as documentation of the original plan, not as what the team actually runs.

## Why

- With the team working in parallel from H+0, a single shared database eliminates
  the problem of syncing state (seeds, migrations, retroactive test data) between
  machines — everyone reads and writes the same Postgres the whole time, with no
  "works on my machine".
- One less local environment dependency (Docker installed and running) in a 24-hour
  window where any setup friction is costly.
- **Accepted cost:** we lose the full "clone and run without depending on anything
  external" reproducibility that `docker-compose` would give, and the project now
  depends on Railway's availability during the demo. It is also the ready answer
  for the Q&A if a judge asks "why not docker-compose, as the stack document
  describes": it was a deliberate trade of isolated reproducibility for real-time
  team coordination, not an oversight.
- Partial mitigation: `DATABASE_URL`/`REDIS_URL` remain the only thing that
  changes between "cloud" and "local" — nothing in the code assumes Railway
  specifically, so going back to `docker-compose` after the deadline is a change
  of two environment variables, not of architecture.
