import Link from "next/link";
import { formatUsdPerMinute } from "../../lib/format";
import type { Incident } from "../../types/dashboard";

export function IncidentSummary({ incidents }: { incidents: Incident[] }) {
  const top = incidents.filter((incident) => incident.status === "OPEN").slice(0, 3);
  return (
    <section className="panel">
      <div className="panel__heading"><h2>Top open incidents</h2><Link href="/alerts" className="panel__link">View all alerts →</Link></div>
      <div className="incident-summary">
        {top.map((incident) => (
          <Link key={incident.id} href={`/alerts?incident=${incident.id}`} className={`incident-summary__card severity-border--${incident.severity.toLowerCase()}`}>
            <span className={`severity-badge severity-badge--${incident.severity.toLowerCase()}`}>{incident.severity}</span>
            <strong>{incident.title}</strong>
            <p>{incident.dimensions}</p>
            <div className="incident-summary__footer"><span>Since {incident.startedAt}</span><b className="negative">{formatUsdPerMinute(incident.costPerMinute)}</b></div>
          </Link>
        ))}
      </div>
    </section>
  );
}
