import type { PartitionLag } from "../../types/dashboard";

export function PartitionTable({ partitions }: { partitions: PartitionLag[] }) {
  return (
    <section className="panel">
      <div className="panel__heading"><h2>Consumer partitions</h2><p>rollup_minute · {partitions.length} partitions</p></div>
      <div className="table-scroll">
        <table className="ingestion-table ingestion-table--partitions">
          <thead><tr><th>Partition</th><th>Throughput</th><th>Lag</th><th>Status</th></tr></thead>
          <tbody>
            {partitions.map((partition) => (
              <tr key={partition.partition}>
                <td>#{partition.partition}</td>
                <td>{partition.throughput} msg/s</td>
                <td className={partition.status === "DEGRADED" ? "negative" : ""}>{partition.lagSeconds.toFixed(1)}s</td>
                <td><span className={`status status--${partition.status === "DEGRADED" ? "material_drop" : "healthy"}`}>{partition.status === "DEGRADED" ? "Degraded" : "Healthy"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
