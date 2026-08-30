import type { IngestionBatch } from "../../types/dashboard";

const statusLabel: Record<IngestionBatch["status"], string> = { OK: "OK", WARN: "Warn", ERROR: "Error" };

export function BatchTable({ batches }: { batches: IngestionBatch[] }) {
  return (
    <section className="panel">
      <div className="panel__heading"><h2>Recent batches</h2><p>rollup_minute consumer</p></div>
      <div className="table-scroll">
        <table className="ingestion-table ingestion-table--batches">
          <thead><tr><th>Batch</th><th>Window</th><th>Rows</th><th>Duration</th><th>Status</th></tr></thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td><strong>{batch.id}</strong></td>
                <td>{batch.window}</td>
                <td>{batch.rows.toLocaleString("en-US")}</td>
                <td className={batch.durationMs > 2000 ? "negative" : ""}>{batch.durationMs}ms</td>
                <td><span className={`status status--batch-${batch.status.toLowerCase()}`}>{statusLabel[batch.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
