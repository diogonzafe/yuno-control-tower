import type { EvidenceObject } from "@control-tower/contracts";
import type { Catalog } from "@control-tower/app";
import { formatPercent, formatSignedPp, formatUsdPerMin } from "./format";
import { CAUSAL_DIMENSION_LABELS, COUNTRY_NAMES, declineCodeLabel, PLAYBOOKS } from "./labels";

export type Audience = "operations" | "executive";

// The roadmap's deterministic fallback narrator: EvidenceObject is the closed
// set of numbers the text is allowed to say, so both lines below are pure
// formatting of fields already computed upstream — never new arithmetic.

export function dimensionLabel(dimensions: EvidenceObject["dimensions"], catalog: Catalog): string {
  const parts: string[] = [];
  if (dimensions.providerId) parts.push(catalog.providers.find((p) => p.id === dimensions.providerId)?.name ?? dimensions.providerId);
  if (dimensions.country) parts.push(COUNTRY_NAMES[dimensions.country] ?? dimensions.country);
  if (dimensions.paymentMethod) parts.push(dimensions.paymentMethod);
  if (dimensions.issuerId) parts.push(catalog.issuers.find((i) => i.id === dimensions.issuerId)?.name ?? dimensions.issuerId);
  if (dimensions.merchantId) parts.push(catalog.merchants.find((m) => m.id === dimensions.merchantId)?.name ?? dimensions.merchantId);
  return parts.length ? parts.join(" · ") : "the whole portfolio";
}

export function causalDimensionOf(dimensions: EvidenceObject["dimensions"]): keyof typeof CAUSAL_DIMENSION_LABELS {
  if (dimensions.issuerId) return "issuer";
  if (dimensions.providerId) return "provider";
  if (dimensions.paymentMethod) return "method";
  return "merchant";
}

export function headline(evidence: EvidenceObject, catalog: Catalog): string {
  return `${dimensionLabel(evidence.dimensions, catalog)} is degrading`;
}

export function operationsNarrative(evidence: EvidenceObject, catalog: Catalog): string {
  const mix = evidence.dominantDecline ? evidence.declineMix.find((entry) => entry.code === evidence.dominantDecline) : undefined;
  const mixLine =
    evidence.dominantDecline && mix
      ? ` Code ${evidence.dominantDecline} (${declineCodeLabel(evidence.dominantDecline)}) rose from ${formatPercent(mix.baselineShare, 0)} to ${formatPercent(mix.observedShare, 0)} of declines.`
      : "";
  const source = evidence.expectedSource === "cross_sectional" ? "vs. its siblings this window" : evidence.expectedSource === "temporal" ? "vs. its own recent history" : "vs. the merchant's configured baseline";
  return `${dimensionLabel(evidence.dimensions, catalog)} is confirmed at ${formatPercent(evidence.observedRate)} against an expected ${formatPercent(evidence.expectedRate)} (${source}), over ${evidence.attempts} attempts across ${evidence.consecutiveWindows} consecutive window${evidence.consecutiveWindows === 1 ? "" : "s"}.${mixLine}`;
}

export function executiveNarrative(evidence: EvidenceObject, catalog: Catalog): string {
  const dim = causalDimensionOf(evidence.dimensions);
  return `Losing at least ${formatUsdPerMin(evidence.costUsdPerMin)} on ${dimensionLabel(evidence.dimensions, catalog)} (${formatSignedPp(evidence.deltaPp)} vs. expected). Recommended: ${PLAYBOOKS[dim].title.toLowerCase()}.`;
}

export function playbookFor(evidence: EvidenceObject) {
  return PLAYBOOKS[causalDimensionOf(evidence.dimensions)];
}
