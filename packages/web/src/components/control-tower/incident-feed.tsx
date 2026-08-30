"use client";

import type { Catalog, IncidentRow } from "@control-tower/app";
import { formatPercent, formatRelativeSince, formatUsdPerMin } from "../../lib/format";
import { dimensionLabel } from "../../lib/narrative";
import { statusBadge } from "../../lib/status";

function IncidentCard({
  incident,
  selectedId,
  onSelect,
  catalog,
}: {
  incident: IncidentRow;
  selectedId: string | null;
  onSelect: (id: string) => void;
  catalog: Catalog | null;
}) {
  const e = incident.evidence;
  const badge = statusBadge(incident);
  const ciLow = e.ci.low * 100, ciHigh = e.ci.high * 100;
  const borderTier = incident.status === "open" ? badge.tier : "default";

  return (
    <article
      className={`ct-incident ct-incident--${borderTier} ${incident.incidentId === selectedId ? "ct-incident--selected" : ""}`}
      onClick={() => onSelect(incident.incidentId)}
    >
      <div className="ct-incident__top">
        <div className="ct-incident__id">
          <div className="ct-incident__tags">
            <span className={`ct-badge ct-badge--${badge.tier}`}>{badge.label}</span>
            <span className="ct-fingerprint">{incident.fingerprint}</span>
          </div>
          <h4>{dimensionLabel(e.dimensions, catalog ?? { merchants: [], providers: [], issuers: [] })} is degrading</h4>
          <span>Since {formatRelativeSince(e.startedAt, e.startedAtExact)} · {e.attempts} attempts</span>
        </div>
        <div className="ct-incident__cost">
          <strong>{formatUsdPerMin(incident.costUsdPerMin)}</strong>
          <span>conservative floor</span>
        </div>
      </div>

      <div>
        <div className="ct-ci-bar">
          <div className="ct-ci-bar__fill" style={{ left: `${ciLow}%`, width: `${Math.max(1, ciHigh - ciLow)}%`, background: "rgba(232,80,80,0.12)", borderColor: "currentColor" }} />
          <div className="ct-ci-bar__expected" style={{ left: `${e.expectedRate * 100}%` }} />
          <div className="ct-ci-bar__observed" style={{ left: `${e.observedRate * 100}%` }} />
        </div>
        <div className="ct-ci-labels">
          <span>observed {formatPercent(e.observedRate)} · CI{Math.round(e.ci.level * 100)} {formatPercent(e.ci.low)}–{formatPercent(e.ci.high)}</span>
          <span>expected {formatPercent(e.expectedRate)} · {e.expectedSource.replace("_", "-")}</span>
        </div>
      </div>

      <div className="ct-chips">
        {Object.entries(e.dimensions).map(([key, value]) => value && <span className="ct-chip" key={key}>{key}={value}</span>)}
        <span className="ct-incident__cta">View evidence →</span>
      </div>
    </article>
  );
}

export function IncidentFeed({
  incidents,
  history,
  loading,
  selectedId,
  onSelect,
  catalog,
}: {
  incidents: IncidentRow[];
  history: IncidentRow[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  catalog: Catalog | null;
}) {
  const open = [...incidents].sort((a, b) => b.costUsdPerMin - a.costUsdPerMin);

  return (
    <section className="ct-incidents">
      <div className="ct-incidents__head">
        <h3>Incidents <span>ordered by cost per minute</span></h3>
        <span className="ct-incidents__count">{open.length} open</span>
      </div>

      {loading && (
        <div className="ct-loading">
          <div className="ct-loading__title"><i /><span>Connecting to the incident stream…</span></div>
        </div>
      )}

      {!loading && open.length === 0 && (
        <div className="ct-silence">
          <div className="ct-silence__title"><i /><span>Silence — and that is the expected outcome</span></div>
          <p>No cell is confirmed down for three consecutive windows right now. The Wilson interval covers the expected rate across the low-volume tail, so there is nothing to claim.</p>
        </div>
      )}

      {open.map((incident) => (
        <IncidentCard key={incident.incidentId} incident={incident} selectedId={selectedId} onSelect={onSelect} catalog={catalog} />
      ))}

      {!loading && (
        <>
          <div className="ct-incidents__head" style={{ marginTop: 14 }}>
            <h3>History</h3>
            <span className="ct-incidents__count">{history.length}</span>
          </div>

          {history.length === 0 ? (
            <p className="ct-wilson-note">No resolved or monitoring incidents yet.</p>
          ) : (
            history.map((incident) => (
              <IncidentCard key={incident.incidentId} incident={incident} selectedId={selectedId} onSelect={onSelect} catalog={catalog} />
            ))
          )}
        </>
      )}
    </section>
  );
}
