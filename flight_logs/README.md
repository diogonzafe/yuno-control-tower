---
title: "Flight Logs — Decision Log Index"
doc_id: "YCT-FLIGHT-001"
doc_related:
  - "YCT-AGENTS-001"
  - "YCT-RULES-001"
domain: "decision-log"
dimension_schema: []
time: "2026-08-30T08:19:32Z"
---

# Flight Logs

This directory contains the implementation decisions made during the hackathon.

Each flight log records the decision title, the options considered, what we
chose, and why we chose it, including its costs and trade-offs.

Files:

1. `fixed_expected_conversion.md` — Fixed expected conversion per merchant
2. `dados_historicos_d-2.md` — Historical data through D-2
3. `synchronous_transactions.md` — Synchronous transactions
4. `dimension_value_counts.md` — Number of values for each dimension
5. `usd_normalization.md` — USD normalization with local currency preservation
6. `ai_agent_module.md` — Mastra, investigator tools, memory, and playbook ownership
7. `transaction_event_contract.md` — Transaction event contract on the Redis Stream
8. `micro_batch_ingestion_with_dedup.md` — Micro-batch ingestion with deduplication via RETURNING
9. `wilson_detection.md` — Wilson detector and `ConfirmedDrop` output contract
10. `managed_cloud_infra.md` — Managed cloud Postgres/Redis instead of docker-compose
11. `who_assembles_the_evidence_object.md` — `diagnose/` assembles the `EvidenceObject`, not the agent
12. `diagnosis_by_deficit_density.md` — Deficit density over absolute deficit; peeling around a beam search
13. `decline_mix_catalogue_reference.md` — Catalogue baseline as decline-mix reference; deterministic 91 disambiguation
14. `priority_by_conservative_cost.md` — Priority as conservative cost per minute, with no separate confidence weight
15. `auditable_agent_summaries.md` — Structured public decision summaries instead of chain-of-thought
16. `deterministic_trail_and_fingerprint.md` — The fallback also produces an investigation trail; fingerprint carries the dominant decline
17. `detector_state_in_memory.md` — Confirmed signals and `PersistenceState` live only in process memory (ring buffer + SSE), never in `incidents`; the tick is timer-driven, not ingest-driven
