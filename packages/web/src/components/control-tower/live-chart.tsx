"use client";

import { useMemo } from "react";
import type { ProviderMinutePoint } from "@control-tower/app";
import type { Catalog } from "@control-tower/app";
import type { ActiveIncident } from "../../lib/use-active-injections";

const PROVIDER_COLORS: Record<string, string> = { stripe: "#E8EAF5", adyen: "#6B78F0", mercado_pago: "oklch(0.72 0.10 305)" };
const FALLBACK_COLORS = ["#8B95F5", "#6B78F0", "#E8EAF5", "oklch(0.72 0.10 305)"];

const W = 800, H = 220, Y_MIN = 0.5, Y_MAX = 1;
const y = (rate: number) => H - ((rate - Y_MIN) / (Y_MAX - Y_MIN)) * H;

export function LiveChart({ series, catalog, injections }: { series: ProviderMinutePoint[]; catalog: Catalog | null; injections: ActiveIncident[] }) {
  const { paths, legend, buckets, markers } = useMemo(() => {
    const byProvider = new Map<string, ProviderMinutePoint[]>();
    for (const point of series) {
      const list = byProvider.get(point.providerId) ?? [];
      list.push(point);
      byProvider.set(point.providerId, list);
    }

    const providerIds = [...byProvider.keys()].sort();
    const bucketSet = [...new Set(series.map((point) => point.bucket))].sort();
    const recentBuckets = bucketSet.slice(-60);
    const x = (index: number) => (recentBuckets.length <= 1 ? W : (index / (recentBuckets.length - 1)) * W);

    const paths = providerIds.map((id, index) => {
      const points = byProvider.get(id)!;
      const byBucket = new Map(points.map((point) => [point.bucket, point]));
      const coords: string[] = [];
      let lastRate = 0.9;
      recentBuckets.forEach((bucket, bucketIndex) => {
        const point = byBucket.get(bucket);
        const rate = point && point.attempts > 0 ? point.approved / point.attempts : lastRate;
        lastRate = rate;
        coords.push(`${x(bucketIndex)},${y(rate)}`);
      });
      const color = PROVIDER_COLORS[id] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
      const latest = points[points.length - 1];
      const latestRate = latest && latest.attempts > 0 ? latest.approved / latest.attempts : null;
      return { id, color, d: coords.length > 1 ? `M${coords.join(" L")}` : "", latestRate };
    });

    const legend = paths.map((path) => ({
      id: path.id,
      name: catalog?.providers.find((provider) => provider.id === path.id)?.name ?? path.id,
      color: path.color,
      rate: path.latestRate,
    }));

    // One marker per injection, positioned at the bucket it first affected —
    // the earliest bucket at or after startsAt, or the chart's right edge if
    // the injection is more recent than any bucket drawn yet.
    const markers = injections
      .map((incident) => {
        const index = recentBuckets.findIndex((bucket) => bucket >= incident.startsAt);
        const resolved = index === -1 ? recentBuckets.length - 1 : index;
        return resolved < 0 ? null : { id: incident.id, x: x(resolved) };
      })
      .filter((marker): marker is { id: string; x: number } => marker !== null);

    return { paths, legend, buckets: recentBuckets, markers };
  }, [series, catalog, injections]);

  const first = buckets[0], mid = buckets[Math.floor(buckets.length / 2)], last = buckets[buckets.length - 1];
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) : "");

  return (
    <section className="ct-panel">
      <div className="ct-panel__head">
        <div><h3>Live conversion · 1-minute windows</h3><p>Every provider, last {buckets.length} minutes</p></div>
        <div className="ct-legend">
          {legend.map((entry) => (
            <div className="ct-legend__item" key={entry.id}>
              <span className="ct-legend__swatch" style={{ background: entry.color }} />
              <span>{entry.name}</span>
              <b style={{ color: entry.color }}>{entry.rate !== null ? `${(entry.rate * 100).toFixed(0)}%` : "—"}</b>
            </div>
          ))}
        </div>
      </div>

      <div className="ct-chart-wrap">
        <div className="ct-chart-yaxis"><span>100%</span><span>90%</span><span>80%</span><span>70%</span><span>60%</span><span>50%</span></div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Conversion rate per provider over the last hour">
          {[0, 44, 88, 132, 176, 220].map((gy) => <line key={gy} x1={0} y1={gy} x2={W} y2={gy} stroke="rgba(232,234,245,0.08)" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          {paths.map((path) => path.d && <path key={path.id} d={path.d} fill="none" stroke={path.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />)}
          {markers.map((marker) => (
            <g key={marker.id}>
              <line x1={marker.x} y1={0} x2={marker.x} y2={H} stroke="var(--amber)" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              <text x={marker.x + 4} y={12} fill="var(--amber)" fontSize={10} fontFamily="var(--mono)">injected</text>
            </g>
          ))}
        </svg>
      </div>
      <div className="ct-chart-xaxis"><span>{fmt(first)}</span><span>{fmt(mid)}</span><span>{fmt(last)}</span></div>
    </section>
  );
}
