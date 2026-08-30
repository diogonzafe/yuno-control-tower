import { formatPercent, formatUsdCompact, formatUsdPerMinute } from "../../lib/format";
import type { MerchantHealth } from "../../types/dashboard";

function initials(name: string): string { const parts = name.split(" ").filter(Boolean); return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase(); }

export function MerchantTable({ merchants }: { merchants: MerchantHealth[] }) {
  return <section className="panel"><div className="panel__heading"><h2>Merchants</h2></div><div className="portfolio-merchant-list">{merchants.map((merchant) => { const delta = merchant.current - merchant.expected; return <article className={`portfolio-merchant portfolio-merchant--${merchant.status.toLowerCase()}`} key={merchant.id}><div className="portfolio-merchant__head"><span className="avatar">{initials(merchant.name)}</span><div><strong>{merchant.name}</strong><small>{merchant.id} · {merchant.countries.join(" ")} · trigger {merchant.triggerPp.toFixed(1)}pp</small></div></div><div className="portfolio-merchant__metrics"><span>Expected<b>{formatPercent(merchant.expected)}</b></span><span>Current<b>{formatPercent(merchant.current)}</b></span><span>Delta<b className={delta < 0 ? "negative" : "positive"}>{delta.toFixed(1)}pp</b></span><span>Volume<b>{formatUsdCompact(merchant.volumeUsd)}</b></span></div><footer><span>Estimated exposure</span><strong className={delta < 0 ? "negative" : ""}>{formatUsdPerMinute(merchant.exposurePerMinute)}</strong></footer></article>; })}</div></section>;
}
