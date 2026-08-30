import { throughputSeries } from "../../lib/ingestion-data";

const W = 680, H = 180, PAD_L = 36, PAD_R = 8, PAD_T = 12, PAD_B = 22;
const CW = W - PAD_L - PAD_R, CH = H - PAD_T - PAD_B;
const MIN = Math.min(...throughputSeries) - 3, MAX = Math.max(...throughputSeries) + 3;

const x = (i: number) => PAD_L + (i / (throughputSeries.length - 1)) * CW;
const y = (v: number) => PAD_T + (1 - (v - MIN) / (MAX - MIN)) * CH;

const linePoints = throughputSeries.map((v, i) => `${x(i)},${y(v)}`).join(" ");
const areaPoints = `${x(0)},${y(MIN)} ${linePoints} ${x(throughputSeries.length - 1)},${y(MIN)}`;
const latest = throughputSeries[throughputSeries.length - 1];

export function ThroughputChart() {
  return (
    <section className="panel">
      <div className="panel__heading"><h2>Ingestion throughput</h2><p>Messages per second · last 12 minutes</p></div>
      <div className="chart-plot chart-plot--compact">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Ingestion throughput steady around ${latest} messages per second over the last twelve minutes`}>
          {[MIN, (MIN + MAX) / 2, MAX].map((t) => <line key={t} x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="chart-gridline" />)}
          <polygon points={areaPoints} className="throughput-area" />
          <polyline points={linePoints} className="throughput-line" />
          <circle cx={x(throughputSeries.length - 1)} cy={y(latest)} r={5} className="throughput-end" />
        </svg>
      </div>
      <div className="chart-callout chart-callout--muted"><strong>{latest} msg/s</strong><span>current throughput, within normal range</span></div>
    </section>
  );
}
