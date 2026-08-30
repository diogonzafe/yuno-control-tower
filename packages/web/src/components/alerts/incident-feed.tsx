import { formatUsdPerMinute } from "../../lib/format";
import type { Incident } from "../../types/dashboard";

export function IncidentFeed({ incidents, selectedId, onSelect }: { incidents: Incident[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <section className="panel incident-feed">
      <div className="panel__heading"><div><h2>Incidents</h2><p>Ordered by current estimated exposure.</p></div><span className="live-dot">Live</span></div>
      <div className="incident-feed__list">
      {incidents.length === 0 && <p className="incident-feed__empty">No incidents match this filter.</p>}
      {incidents.map((incident) => (
        <article className={`incident ${incident.id === selectedId ? "incident--selected" : ""}`} key={incident.id} onClick={() => onSelect(incident.id)}>
          <div className="incident__topline">
            <span className={`incident__state incident__state--${incident.status.toLowerCase()}`}>{incident.status}</span>
            <span className={`severity-badge severity-badge--${incident.severity.toLowerCase()}`}>{incident.severity}</span>
            <time>Since {incident.startedAt}</time>
          </div>
          <h3>{incident.title} {incident.isSimulated && <em>Simulated</em>}</h3>
          <code>{incident.dimensions}</code>
          <div className="incident__footer"><p>{incident.recommendation}</p><strong>{formatUsdPerMinute(incident.costPerMinute)}</strong></div>
        </article>
      ))}
      </div>
    </section>
  );
}
