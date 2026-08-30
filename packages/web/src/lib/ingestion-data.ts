import type { IngestionBatch, PartitionLag, PipelineStage } from "../types/dashboard";

// Temporary presentation fixture. API/SSE wiring belongs here once packages/app exposes it.
export const pipelineStages: PipelineStage[] = [
  { name: "Ingest", detail: "41 msg/s · topic tx.raw.v1", status: "HEALTHY" },
  { name: "Rollup", detail: "lag 4.2s on partition 2", status: "DEGRADED" },
  { name: "Detect", detail: "tick every 60s · Wilson 95% CI", status: "HEALTHY" },
  { name: "Alert", detail: "9 open · dispatch under 2s", status: "HEALTHY" },
];

export const partitionLags: PartitionLag[] = [
  { partition: 0, lagSeconds: 0.6, throughput: 11, status: "HEALTHY" },
  { partition: 1, lagSeconds: 0.9, throughput: 9, status: "HEALTHY" },
  { partition: 2, lagSeconds: 4.2, throughput: 12, status: "DEGRADED" },
  { partition: 3, lagSeconds: 1.1, throughput: 9, status: "HEALTHY" },
];

export const recentBatches: IngestionBatch[] = [
  { id: "batch_2031", window: "14:31–14:32 UTC", rows: 8214, durationMs: 612, status: "OK" },
  { id: "batch_2030", window: "14:30–14:31 UTC", rows: 7986, durationMs: 588, status: "OK" },
  { id: "batch_2029", window: "14:29–14:30 UTC", rows: 8420, durationMs: 4210, status: "WARN" },
  { id: "batch_2028", window: "14:28–14:29 UTC", rows: 7750, durationMs: 601, status: "OK" },
  { id: "batch_2027", window: "14:27–14:28 UTC", rows: 8102, durationMs: 594, status: "OK" },
  { id: "batch_2026", window: "14:26–14:27 UTC", rows: 0, durationMs: 0, status: "ERROR" },
  { id: "batch_2025", window: "14:25–14:26 UTC", rows: 7998, durationMs: 579, status: "OK" },
  { id: "batch_2024", window: "14:24–14:25 UTC", rows: 7911, durationMs: 583, status: "OK" },
];

export const throughputSeries = [38, 40, 39, 41, 44, 42, 37, 41, 40, 43, 39, 41];

export const ingestionIssue = {
  title: "Rollup consumer lag elevated on partition 2",
  detail: "Lag climbed to 4.2s after a redeploy at 14:24 UTC. Autoscaling added a worker; lag is recovering.",
  impact: "Detection windows for merchants routed through partition 2 may lag by up to 5 seconds.",
};
