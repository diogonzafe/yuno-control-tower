import type { ProviderHealthRow } from "../../types/dashboard";

function tone(conversion: number): "critical" | "warn" | "healthy" { return conversion < 70 ? "critical" : conversion < 80 ? "warn" : "healthy"; }

export function ProviderHealthGrid({ providers, rows }: { providers: string[]; rows: ProviderHealthRow[] }) {
  return <section className="panel"><div className="panel__heading"><h2>Provider × country health</h2></div><div className="provider-health-list">{rows.map((row) => <article key={row.countryMethod} className="provider-health-row"><strong>{row.countryMethod}</strong><div>{providers.map((provider) => { const cell = row.cells[provider]; return <span key={provider}><small>{provider}</small>{cell ? <b className={`heat-cell heat-cell--${tone(cell.conversion)}`} title={`${cell.affectedMerchants} merchants affected`}>{cell.conversion}%</b> : <b className="heat-cell heat-cell--na">—</b>}</span>; })}</div></article>)}</div></section>;
}
