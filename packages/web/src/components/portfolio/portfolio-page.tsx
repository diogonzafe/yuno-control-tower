"use client";

import { useState } from "react";
import { incidents } from "../../lib/alerts-data";
import { dashboardSummary, providerHealthRows, providers } from "../../lib/dashboard-data";
import { formatCompactNumber, formatPercent, formatSigned, formatUsdCompact, formatUsdPerMinute } from "../../lib/format";
import { topOffenders } from "../../lib/merchants-data";
import { ConversionChart } from "./conversion-chart";
import { IncidentSummary } from "./incident-summary";
import { MerchantTable } from "./merchant-table";
import { MetricCard } from "./metric-card";
import { ProviderHealthGrid } from "./provider-health-grid";
import { SharedCause } from "./shared-cause";
import { rangeLabels, Toolbar, type TimeRange } from "./toolbar";

export function PortfolioPage() {
  const [range, setRange] = useState<TimeRange>("6h");
  const s = dashboardSummary;
  const primaryIncident = incidents[0];
  const openIncidents = incidents.filter((incident) => incident.status === "OPEN");
  const openExposurePerMinute = openIncidents.reduce((sum, incident) => sum + incident.costPerMinute, 0);

  return (
    <div className="portfolio-page">
      <header className="page-header">
        <div><span className="eyebrow">Yuno portfolio</span><h1>All merchants · {rangeLabels[range]}</h1></div>
        <Toolbar range={range} onRangeChange={setRange} />
      </header>

      <section className="metrics" aria-label="Portfolio summary">
        <MetricCard label="Merchants live" value={String(s.merchantsLive)} delta={`${s.merchantsFlagged} flagged`} deltaTone="danger" detail={`${s.regionsCount} regions · ${s.providersCount} providers`} />
        <MetricCard label="Portfolio conversion" value={formatPercent(s.portfolioConversion)} delta={formatSigned(s.conversionDeltaPp, "pp")} deltaTone="danger" detail="volume-weighted vs expected" />
        <MetricCard label="Attempts" value={formatCompactNumber(s.attempts)} delta={formatSigned(s.attemptsDeltaPct, "%")} deltaTone="positive" detail={`last ${s.attemptsWindowMinutes} minutes`} />
        <MetricCard label="Approved volume" value={formatUsdCompact(s.approvedVolumeUsd)} delta={formatSigned(s.approvedVolumeDeltaPct, "%")} deltaTone="danger" detail="FX frozen at creation" />
        <MetricCard label="Open incidents" value={String(openIncidents.length)} delta={formatUsdPerMinute(openExposurePerMinute)} deltaTone="danger" detail={`${primaryIncident.affectedMerchants} share one provider cause`} />
      </section>

      <SharedCause affectedMerchants={primaryIncident.affectedMerchants} exposurePerMinute={primaryIncident.costPerMinute} incidentId={primaryIncident.id} />

      <div className="dashboard-grid">
        <MerchantTable merchants={topOffenders(4)} />
        <ProviderHealthGrid providers={providers} rows={providerHealthRows} />
      </div>

      <ConversionChart />

      <IncidentSummary incidents={incidents} />
    </div>
  );
}
