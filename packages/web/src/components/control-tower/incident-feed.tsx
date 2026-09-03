"use client";

import type { Catalog, IncidentRow } from "@control-tower/app";
import type { PendingSignal } from "@control-tower/contracts";
import { formatPercent, formatRelativeSince } from "../../lib/format";
import { dimensionLabel } from "../../lib/narrative";
import { IncidentCard } from "./incident-card";

// Not yet a confirmed incident — still building persistence confidence — so
// it gets its own dashed, unclickable card instead of joining the real list
// (no incidentId, no evidence object, nothing to select or drill into yet).
function PendingCard({ signal, catalog }: { signal: PendingSignal; catalog: Catalog | null }) {
  const ciLow = signal.ciLow * 100, ciHigh = signal.ciHigh * 100;

  return (
    <article className="ct-incident ct-incident--pending">
      <div className="ct-incident__top">
        <div className="ct-incident__id">
          <div className="ct-incident__tags">
            <span className="ct-badge ct-badge--pending">Watching</span>
            <span className="ct-pending-progress">{signal.windowsConfirmed}/{signal.windowsRequired} windows</span>
          </div>
          <h4>{dimensionLabel(signal.dimensions, catalog ?? { merchants: [], providers: [], issuers: [] })} may be degrading</h4>
          <span>Since {formatRelativeSince(signal.firstBucket, true)} · {signal.attempts} attempts</span>
        </div>
      </div>

      <div>
        <div className="ct-ci-bar">
          <div className="ct-ci-bar__fill" style={{ left: `${ciLow}%`, width: `${Math.max(1, ciHigh - ciLow)}%`, background: "rgba(232,80,80,0.12)", borderColor: "currentColor" }} />
          <div className="ct-ci-bar__expected" style={{ left: `${signal.expectedRate * 100}%` }} />
          <div className="ct-ci-bar__observed" style={{ left: `${signal.observedRate * 100}%` }} />
        </div>
        <div className="ct-ci-labels">
          <span>observed {formatPercent(signal.observedRate)} · CI{Math.round(signal.ciLevel * 100)} {formatPercent(signal.ciLow)}–{formatPercent(signal.ciHigh)}</span>
          <span>expected {formatPercent(signal.expectedRate)} · {signal.expectedSource.replace("_", "-")}</span>
        </div>
      </div>

      <div className="ct-chips">
        {Object.entries(signal.dimensions).map(([key, value]) => value && <span className="ct-chip" key={key}>{key}={value}</span>)}
      </div>
    </article>
  );
}

export function IncidentFeed({
  incidents,
  pendingSignals,
  loading,
  selectedId,
  onSelect,
  catalog,
}: {
  incidents: IncidentRow[];
  pendingSignals: PendingSignal[];
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

      {!loading && open.length === 0 && pendingSignals.length === 0 && (
        <div className="ct-silence">
          <div className="ct-silence__title"><i /><span>Silence — and that is the expected outcome</span></div>
          <p>No cell is confirmed down for three consecutive windows right now. The Wilson interval covers the expected rate across the low-volume tail, so there is nothing to claim.</p>
        </div>
      )}

      {pendingSignals.map((signal) => (
        <PendingCard key={`${signal.dimensions.merchantId ?? ""}|${signal.dimensions.country ?? ""}|${signal.dimensions.paymentMethod ?? ""}|${signal.dimensions.providerId ?? ""}|${signal.dimensions.issuerId ?? ""}`} signal={signal} catalog={catalog} />
      ))}

      {open.map((incident) => (
        <IncidentCard key={incident.incidentId} incident={incident} selectedId={selectedId} onSelect={onSelect} catalog={catalog} />
      ))}
    </section>
  );
}
