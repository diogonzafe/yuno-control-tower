"use client";

import { useMemo, useState } from "react";
import { buildInjectedIncident, incidents as initialIncidents } from "../../lib/alerts-data";
import { formatUsdPerMinute } from "../../lib/format";
import { MetricCard } from "../portfolio/metric-card";
import { AlertFilters, type AlertFilter } from "./alert-filters";
import { EvidencePanel } from "./evidence-panel";
import { IncidentFeed } from "./incident-feed";
import { InjectConsole } from "./inject-console";

export function AlertsPage({ initialIncidentId, showGrouped }: { initialIncidentId?: string; showGrouped?: boolean }) {
  const [incidentList, setIncidentList] = useState(initialIncidents);
  const [selectedId, setSelectedId] = useState(initialIncidentId && initialIncidents.some((i) => i.id === initialIncidentId) ? initialIncidentId : initialIncidents[0].id);
  const [filter, setFilter] = useState<AlertFilter>("ALL");

  const filtered = useMemo(() => (filter === "ALL" ? incidentList : incidentList.filter((incident) => incident.status === filter)), [incidentList, filter]);
  const selected = incidentList.find((incident) => incident.id === selectedId) ?? null;

  const open = incidentList.filter((incident) => incident.status === "OPEN");
  const exposurePerMinute = open.reduce((sum, incident) => sum + incident.costPerMinute, 0);
  const critical = open.filter((incident) => incident.severity === "CRITICAL").length;

  return (
    <div className="alerts-page">
      <header className="page-header">
        <div><span className="eyebrow">Yuno portfolio</span><h1>Alerts</h1></div>
      </header>

      <section className="metrics metrics--compact" aria-label="Alerts summary">
        <MetricCard label="Open incidents" value={String(open.length)} deltaTone="danger" detail="Require human review" />
        <MetricCard label="Combined exposure" value={formatUsdPerMinute(exposurePerMinute)} deltaTone="danger" detail="Sum of open incidents" />
        <MetricCard label="Critical severity" value={String(critical)} deltaTone="danger" detail="Highest priority right now" />
        <MetricCard label="Total tracked" value={String(incidentList.length)} deltaTone="muted" detail="Open, monitoring & resolved" />
      </section>

      {showGrouped && <p className="shared-cause__confirm">Grouped the Adyen · BR · CARD incidents into one routing action · pending human approval</p>}

      <AlertFilters active={filter} onChange={setFilter} />

      <div className="dashboard-grid">
        <IncidentFeed incidents={filtered} selectedId={selectedId} onSelect={setSelectedId} />
        <EvidencePanel incident={selected} />
      </div>

      <InjectConsole onInject={(input) => { const injected = buildInjectedIncident(input); setIncidentList((current) => [injected, ...current]); setSelectedId(injected.id); setFilter("ALL"); }} />
    </div>
  );
}
