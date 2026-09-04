"use client";

import { useMemo, useState } from "react";
import type { IncidentRow } from "@control-tower/app";
import { useCatalog } from "../../lib/use-catalog";
import { useControlTowerStream } from "../../lib/use-control-tower-stream";
import { dimensionLabel } from "../../lib/narrative";
import { statusBadge } from "../../lib/status";
import { IncidentCard } from "./incident-card";
import { SplitShell } from "./split-shell";

const STATUS_OPTIONS = ["resolved", "inconclusive", "monitoring"] as const;

export function IncidentHistory() {
  const { snapshot } = useControlTowerStream();
  const { catalog } = useCatalog();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [merchantFilter, setMerchantFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loading = snapshot === null;
  const closed = (snapshot?.incidents ?? []).filter((incident) => incident.status !== "open");
  const selected = closed.find((incident) => incident.incidentId === selectedId) ?? null;

  const merchantOptions = useMemo(
    () => [...new Set(closed.map((incident) => incident.evidence.dimensions.merchantId).filter(Boolean))] as string[],
    [closed],
  );

  const filtered = closed
    .filter((incident) => !statusFilter || incident.status === statusFilter)
    .filter((incident) => !merchantFilter || incident.evidence.dimensions.merchantId === merchantFilter)
    .filter((incident) => {
      if (!search.trim()) return true;
      const needle = search.trim().toLowerCase();
      const label = dimensionLabel(incident.evidence.dimensions, catalog ?? { merchants: [], providers: [], issuers: [] }).toLowerCase();
      return incident.fingerprint.toLowerCase().includes(needle) || label.includes(needle);
    })
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));

  return (
    <SplitShell selected={selected} catalog={catalog}>
      <div className="ct-page">
        <div className="ct-page__inner">
          <div className="ct-history__head">
            <h1>Incident history</h1>
            <p>Every incident this run has closed the book on — resolved, inconclusive, or still quietly monitoring after its first confirmation.</p>
          </div>

          <div className="ct-history__filters">
            <input
              type="search"
              placeholder="Search by dimension or fingerprint…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">any status</option>
              {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{statusBadge({ status, costUsdPerMin: 0 }).label}</option>)}
            </select>
            <select value={merchantFilter} onChange={(event) => setMerchantFilter(event.target.value)}>
              <option value="">any merchant</option>
              {merchantOptions.map((id) => <option key={id} value={id}>{catalog?.merchants.find((m) => m.id === id)?.name ?? id}</option>)}
            </select>
          </div>

          {loading && (
            <div className="ct-loading">
              <div className="ct-loading__title"><i /><span>Connecting to the incident stream…</span></div>
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <p className="ct-wilson-note">No incident matches these filters.</p>
          )}

          <div className="ct-history__list">
            {filtered.map((incident: IncidentRow) => (
              <IncidentCard key={incident.incidentId} incident={incident} selectedId={selectedId} onSelect={setSelectedId} catalog={catalog} />
            ))}
          </div>
        </div>
      </div>
    </SplitShell>
  );
}
