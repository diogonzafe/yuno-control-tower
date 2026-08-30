export function formatPercent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

export function formatSignedPp(deltaPp: number): string {
  const sign = deltaPp > 0 ? "+" : deltaPp < 0 ? "−" : "";
  return `${sign}${Math.abs(deltaPp).toFixed(1)}pp`;
}

export function formatUsd(amountMinor: number): string {
  const value = amountMinor / 100;
  if (Math.abs(value) >= 1000) return `US$ ${(value / 1000).toFixed(1)}k`;
  return `US$ ${Math.round(value).toLocaleString("en-US")}`;
}

export function formatUsdPerMin(amountMinor: number): string {
  return `${formatUsd(amountMinor)}/min`;
}

export function formatLocal(amountMinor: number, currency: string): string {
  const value = amountMinor / 100;
  if (Math.abs(value) >= 1000) return `${currency} ${(value / 1000).toFixed(1)}k`;
  return `${currency} ${Math.round(value).toLocaleString("en-US")}`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
}

export function formatRelativeSince(iso: string, exact: boolean): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  const label = minutes < 1 ? "just now" : minutes === 1 ? "1 min ago" : `${minutes} min ago`;
  return exact ? label : `≈ ${label}`;
}
