---
title: "Flight log — Who assembles the EvidenceObject"
---

# Who assembles the EvidenceObject

**Fixes a public data contract** (`EvidenceObject` in
`packages/contracts/src/incident.ts`) and the boundary between `diagnose/`,
`agent/`, and `orchestrate/`. The documents defined who **consumes** the object
(the narrator, six times: `roadmap.md` §1/§2, `rules.md` §3/§4/§6.4.1,
`AGENTS.md`), but never who **assembles** it — `context/detector.md` §9 only said
that the `incidents.evidence` column is filled by "`diagnose/`, `agent/`, and
`orchestrate/`", without saying which.

## Options considered

- **The agent assembles it.** The investigator finishes the exploration and
  assembles the object with what it found, since it is the one holding the trail.
- **`orchestrate/` assembles it.** Since it is the one that writes to `incidents`,
  it would also be the one to put together the pieces coming from the detector and
  from `diagnose/`.
- **`diagnose/` assembles it**, in a pure function `buildEvidence(signal,
  diagnosis, trail?)`, and both the agentic path and the deterministic beam-search
  end in it.

## What we chose

`diagnose/evidence.ts` assembles the `EvidenceObject`, deterministically. The
agent never assembles it — it only produces the trail, which enters as an optional
argument. `orchestrate/` receives the finished object, persists it verbatim in
`incidents.evidence`, and handles the lifecycle, without inspecting the content.
The narrator consumes the closed object and cannot cite a number absent from it.

The type carries `diagnosisSource: "agent" | "beam_search"`, so the evidence
itself records which path the diagnosis arrived by.

## Why

- **Boundary #3 of `rules.md` §3 decides it on its own.** Every agentic path has a
  deterministic fallback: if the agent assembled the object, then when it failed
  or timed out the beam-search would have to assemble it again — two
  implementations of the same object, diverging at the first rule change. It is
  exactly the bug that the DRY principle in `rules.md` §1 describes.
- **The numbers already belong to `diagnose/`**: causal cell and suppressed echoes
  (residual test), decline-mix shift, cost per minute, priority. Assembling it in
  `orchestrate/` would force `diagnose/` to return a bag of pieces for another
  module to reassemble — a translation layer with no gain.
- **It makes the test that `rules.md` §4 requires of the narrator mandatory and
  cheap** ("the text contains no number absent from the object"): with the object
  as deterministic output, the test runs over a fixed fixture, without touching an
  LLM.
- **Accepted cost:** `diagnose/` takes on one more responsibility beyond
  computing — it also formats the output contract. Accepted because the
  alternative (a separate `evidence/` module just to package it) adds one more
  boundary to cross without removing any duplication, and because the assembly is
  a pure function testable in isolation, not new business logic.
- **A consequence to declare in the Q&A:** the system produces complete, auditable
  evidence even with the entire agentic layer turned off — `diagnosisSource` in
  the object itself is the proof that the fallback ran.
