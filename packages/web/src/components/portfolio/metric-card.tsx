type MetricCardProps = {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "danger" | "positive" | "muted";
  detail: string;
};

export function MetricCard({ label, value, delta, deltaTone = "muted", detail }: MetricCardProps) {
  return (
    <article className={`metric-card ${deltaTone === "danger" ? "metric-card--danger" : ""}`}>
      <p>{label}</p>
      <div className="metric-card__value"><strong>{value}</strong>{delta && <em className={`metric-card__delta metric-card__delta--${deltaTone}`}>{delta}</em>}</div>
      <span>{detail}</span>
    </article>
  );
}
