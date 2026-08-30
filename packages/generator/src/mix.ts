export type PaymentMethod = "CARD" | "PIX";
export type CardBrand = "Visa" | "Mastercard" | "Elo";

export type DeclineCode = {
  code: string;
  rawCode: string;
  weight: number;
  family: "issuer" | "funds" | "fraud" | "credential" | "network" | "auth" | "merchant";
  diagnostic: boolean;
};

export type DeclineMixContext = { country: "AR" | "MX" | "BR"; issuerId: string };

const CARD_DECLINE_MIX: readonly DeclineCode[] = [
  { code: "DO_NOT_HONOR", rawCode: "05", weight: 0.32, family: "issuer", diagnostic: true },
  { code: "INSUFFICIENT_FUNDS", rawCode: "51", weight: 0.26, family: "funds", diagnostic: false },
  { code: "EXPIRED_CARD", rawCode: "54", weight: 0.11, family: "credential", diagnostic: false },
  { code: "REFER_TO_ISSUER", rawCode: "01", weight: 0.08, family: "issuer", diagnostic: true },
  { code: "SUSPECTED_FRAUD", rawCode: "59", weight: 0.05, family: "fraud", diagnostic: true },
  { code: "AUTH_REQUIRED", rawCode: "1A", weight: 0.04, family: "auth", diagnostic: true },
  { code: "NOT_PERMITTED", rawCode: "57", weight: 0.03, family: "issuer", diagnostic: true },
  { code: "RESTRICTED_CARD", rawCode: "62", weight: 0.03, family: "issuer", diagnostic: true },
  { code: "SECURITY_VIOLATION", rawCode: "63", weight: 0.02, family: "fraud", diagnostic: true },
  { code: "PICKUP_CARD", rawCode: "04", weight: 0.02, family: "fraud", diagnostic: false },
  { code: "ISSUER_UNAVAILABLE", rawCode: "91", weight: 0.02, family: "network", diagnostic: true },
  { code: "INVALID_ACCOUNT", rawCode: "14", weight: 0.015, family: "credential", diagnostic: false },
  { code: "LIMIT_EXCEEDED", rawCode: "65", weight: 0.005, family: "funds", diagnostic: false },
];

const PIX_DECLINE_MIX: readonly DeclineCode[] = [
  { code: "PIX_INSUFFICIENT_FUNDS", rawCode: "AM05", weight: 0.55, family: "funds", diagnostic: false },
  { code: "PIX_SPI_TIMEOUT", rawCode: "AB03", weight: 0.15, family: "network", diagnostic: true },
  { code: "PIX_INVALID_TAXID", rawCode: "BE01", weight: 0.15, family: "credential", diagnostic: false },
  { code: "PIX_NOT_AUTHORIZED", rawCode: "DS0G", weight: 0.1, family: "fraud", diagnostic: true },
  { code: "PIX_RECEIVER_REJECTED", rawCode: "BE17", weight: 0.05, family: "merchant", diagnostic: true },
];

export function declineMixFor(
  paymentMethod: PaymentMethod,
  context?: DeclineMixContext,
): readonly DeclineCode[] {
  const baseline = paymentMethod === "CARD" ? CARD_DECLINE_MIX : PIX_DECLINE_MIX;
  if (context === undefined) return baseline;

  const weighted = baseline.map((entry) => ({
    ...entry,
    weight: entry.weight * (1 + variationFor(`${entry.code}:${context.country}:${context.issuerId}`)),
  }));
  const totalWeight = weighted.reduce((total, entry) => total + entry.weight, 0);
  return weighted.map((entry) => ({ ...entry, weight: entry.weight / totalWeight }));
}

export function declineCodeFor(
  paymentMethod: PaymentMethod,
  random: () => number,
  cardBrand?: CardBrand,
  overrideWeights: Readonly<Record<string, number>> = {},
  context?: DeclineMixContext,
): DeclineCode {
  const mix = declineMixFor(paymentMethod, context).map((entry) => ({
    ...entry,
    weight: overrideWeights[entry.code] ?? entry.weight,
  }));
  const selected = pickWeighted(mix, random());

  // Network code 65 is brand-dependent; the internal code must remain unambiguous.
  if (paymentMethod === "CARD" && selected.rawCode === "65" && cardBrand === "Mastercard") {
    return { ...selected, code: "AUTH_REQUIRED" };
  }

  return selected;
}

function variationFor(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 7 - 3) / 100;
}

function pickWeighted(values: readonly DeclineCode[], random: number): DeclineCode {
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new Error("random must be in [0, 1)");
  }

  const totalWeight = values.reduce((total, entry) => total + entry.weight, 0);
  const target = random * totalWeight;
  let cumulativeWeight = 0;
  for (const entry of values) {
    cumulativeWeight += entry.weight;
    if (target < cumulativeWeight) return entry;
  }

  return values.at(-1)!;
}
