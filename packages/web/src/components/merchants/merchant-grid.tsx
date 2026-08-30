import { formatPercent, formatUsdCompact, formatUsdPerMinute } from "../../lib/format";
import type { MerchantHealth } from "../../types/dashboard";

const statusLabel: Record<MerchantHealth["status"], string> = { MATERIAL_DROP: "Material drop", MONITORING: "Monitoring", HEALTHY: "Healthy", INSUFFICIENT_EVIDENCE: "Insufficient evidence" };

function initials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function MerchantGrid({ merchants }: { merchants: MerchantHealth[] }) {
  if (merchants.length === 0) return <p className="incident-feed__empty">No merchants match this filter.</p>;
  return (
    <div className="merchant-grid">
      {merchants.map((merchant) => {
        const delta = merchant.current - merchant.expected;
        const barWidth = Math.min(100, Math.abs(delta) * 8);
        return (
          <article key={merchant.id} className="merchant-card">
            <div className="merchant-card__head">
              <span className="avatar">{initials(merchant.name)}</span>
              <div><strong>{merchant.name}</strong><small>{merchant.id}</small></div>
              <span className={`status status--${merchant.status.toLowerCase()}`}>{statusLabel[merchant.status]}</span>
            </div>
            <div className="merchant-card__stats">
              <div><span>Expected</span><b>{formatPercent(merchant.expected)}</b></div>
              <div><span>Current</span><b>{formatPercent(merchant.current)}</b></div>
              <div><span>Volume</span><b>{formatUsdCompact(merchant.volumeUsd)}</b></div>
              <div><span>Exposure</span><b className={delta < 0 ? "negative" : ""}>{formatUsdPerMinute(merchant.exposurePerMinute)}</b></div>
            </div>
            <div className="delta-bar">
              <span className={delta < 0 ? "negative" : "positive"}>{delta.toFixed(1)}pp vs expected</span>
              <div className="delta-bar__track"><div className={`delta-bar__fill delta-bar__fill--${delta < 0 ? "negative" : "positive"}`} style={{ width: `${barWidth}%` }} /></div>
            </div>
            <footer className="merchant-card__footer"><span>{merchant.countries.join(" · ")}</span><span>trigger {merchant.triggerPp.toFixed(1)}pp</span></footer>
          </article>
        );
      })}
    </div>
  );
}
