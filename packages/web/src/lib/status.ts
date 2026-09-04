import type { DiagnosisConfidence } from "@control-tower/contracts";

export type IncidentTier = "critical" | "warn" | "ok" | "monitoring" | "resolved" | "inconclusive";

export function severityTier(costUsdPerMinCents: number): "critical" | "warn" | "ok" {
  const usdPerMin = costUsdPerMinCents / 100;
  if (usdPerMin >= 200) return "critical";
  if (usdPerMin >= 30) return "warn";
  return "ok";
}

// A confirmed drop and a diagnosed cause are different claims, and the card
// looks the same either way unless we say so. Evidence written before the
// verdict existed reports neither, so it gets no label rather than a guess.
export function causeLabel(confidence: DiagnosisConfidence | undefined): { isolated: boolean; label: string } | null {
  if (confidence === "CONFIRMED") return { isolated: true, label: "Cause isolated" };
  if (confidence === "INCONCLUSIVE") return { isolated: false, label: "Cause not isolated" };
  return null;
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
