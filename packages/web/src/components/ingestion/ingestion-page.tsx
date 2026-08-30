import { streamStatus } from "../../lib/dashboard-data";
import { partitionLags, pipelineStages, recentBatches, throughputSeries } from "../../lib/ingestion-data";
import { MetricCard } from "../portfolio/metric-card";
import { BatchTable } from "./batch-table";
import { IssueBanner } from "./issue-banner";
import { PartitionTable } from "./partition-table";
import { PipelineStages } from "./pipeline-stages";
import { ThroughputChart } from "./throughput-chart";

export function IngestionPage() {
  const degraded = pipelineStages.filter((stage) => stage.status !== "HEALTHY").length;
  const latestThroughput = throughputSeries[throughputSeries.length - 1];

  return (
    <div className="ingestion-page">
      <header className="page-header">
        <div><span className="eyebrow">Yuno portfolio</span><h1>Ingestion</h1></div>
      </header>

      <section className="metrics metrics--compact" aria-label="Ingestion summary">
        <MetricCard label="Throughput" value={`${latestThroughput} msg/s`} detail={`${streamStatus.label} · lag ${streamStatus.lagSeconds.toFixed(1)}s`} />
        <MetricCard label="Pipeline stages" value={`${pipelineStages.length - degraded}/${pipelineStages.length}`} deltaTone={degraded ? "danger" : "positive"} detail={degraded ? `${degraded} degraded` : "All healthy"} />
        <MetricCard label="Batches tracked" value={String(recentBatches.length)} detail="rollup_minute consumer" />
        <MetricCard label="Open issues" value={String(degraded)} deltaTone={degraded ? "danger" : "muted"} detail="Auto-recovering" />
      </section>

      {degraded > 0 && <IssueBanner />}

      <PipelineStages stages={pipelineStages} />

      <div className="dashboard-grid">
        <BatchTable batches={recentBatches} />
        <PartitionTable partitions={partitionLags} />
      </div>

      <ThroughputChart />
    </div>
  );
}
