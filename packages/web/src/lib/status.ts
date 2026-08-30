export type IncidentTier = "critical" | "warn" | "ok" | "monitoring" | "resolved" | "inconclusive";

export function severityTier(costUsdPerMinCents: number): "critical" | "warn" | "ok" {
  const usdPerMin = costUsdPerMinCents / 100;
  if (usdPerMin >= 200) return "critical";
  if (usdPerMin >= 30) return "warn";
  return "ok";
}

export function statusBadge(incident: { status: string; costUsdPerMin: number }): { tier: IncidentTier; label: string } {
  if (incident.status === "open") {
    const tier = severityTier(incident.costUsdPerMin);
    return { tier, label: tier === "critical" ? "Critical" : tier === "warn" ? "Warning" : "Confirmed" };
  }
  if (incident.status === "monitoring") return { tier: "monitoring", label: "Monitoring" };
  if (incident.status === "resolved") return { tier: "resolved", label: "Resolved" };
  return { tier: "inconclusive", label: "Inconclusive" };
}
