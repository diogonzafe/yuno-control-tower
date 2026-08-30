"use client";

import { useEffect, useMemo, useState } from "react";
import { dashboardSummary } from "../../lib/dashboard-data";
import { allMerchants } from "../../lib/merchants-data";
import { MetricCard } from "../portfolio/metric-card";
import { MerchantFilters, type MerchantFilter } from "./merchant-filters";
import { MerchantGrid } from "./merchant-grid";

export function MerchantsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<MerchantFilter>("ALL");
  const [visibleCount, setVisibleCount] = useState(6);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("show") === "all") {
      setVisibleCount(allMerchants.length);
    }
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return allMerchants.filter((merchant) => {
      const matchesStatus = status === "ALL" || merchant.status === status;
      const matchesSearch = !query || merchant.name.toLowerCase().includes(query) || merchant.id.toLowerCase().includes(query);
      return matchesStatus && matchesSearch;
    });
  }, [search, status]);

  const flagged = allMerchants.filter((merchant) => merchant.status === "MATERIAL_DROP" || merchant.status === "MONITORING").length;
  const healthy = allMerchants.filter((merchant) => merchant.status === "HEALTHY").length;

  const visibleMerchants = filtered.slice(0, visibleCount);

  return (
    <div className="merchants-page">
      <header className="page-header">
        <div><span className="eyebrow">Yuno portfolio</span><h1>Merchant view</h1></div>
      </header>

      <section className="metrics metrics--compact" aria-label="Merchant summary">
        <MetricCard label="Merchants live" value={String(dashboardSummary.merchantsLive)} detail={`Showing ${Math.min(visibleCount, filtered.length)} of ${filtered.length} in detail`} />
        <MetricCard label="Flagged" value={String(flagged)} deltaTone="danger" detail="Material drop or monitoring" />
        <MetricCard label="Healthy" value={String(healthy)} deltaTone="positive" detail="Within expected conversion" />
        <MetricCard label="Regions · providers" value={`${dashboardSummary.regionsCount} · ${dashboardSummary.providersCount}`} detail="Across the tracked portfolio" />
      </section>

      <MerchantFilters search={search} onSearch={(value) => { setSearch(value); setVisibleCount(6); }} status={status} onStatus={(value) => { setStatus(value); setVisibleCount(6); }} />

      <MerchantGrid merchants={visibleMerchants} />
      {visibleCount < filtered.length && <a className="load-more" href="/merchants?show=all" onClick={() => setVisibleCount(filtered.length)}>Load {filtered.length - visibleCount} more merchants</a>}
    </div>
  );
}
