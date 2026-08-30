import type { PipelineStage } from "../../types/dashboard";

export function PipelineStages({ stages }: { stages: PipelineStage[] }) {
  return (
    <section className="panel">
      <div className="panel__heading"><h2>Pipeline</h2><p>Ingest → Rollup → Detect → Alert</p></div>
      <div className="pipeline">
        {stages.map((stage, index) => (
          <div className="pipeline__stage" key={stage.name}>
            <div className={`pipeline__node pipeline__node--${stage.status.toLowerCase()}`}>{index + 1}</div>
            <div><strong>{stage.name}</strong><span>{stage.detail}</span></div>
            {index < stages.length - 1 && <div className="pipeline__connector" />}
          </div>
        ))}
      </div>
    </section>
  );
}
