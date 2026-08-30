export type PaymentMethod = "CARD" | "PIX";
export type CardBrand = "Visa" | "Mastercard" | "Elo";

export type DeclineCode = {
  code: string;
  family: "issuer" | "funds" | "fraud" | "credential" | "network" | "auth" | "merchant";
  diagnostic: boolean;
  weight: number;
};

export type DeclineMixContext = { country: "AR" | "MX" | "BR"; issuerId: string };

// `code` is the real primary key of the seeded `decline_codes` table —
// transactions.decline_code carries a NOT NULL foreign key into it, so an
// invented code here is dropped by the ingestion consumer's poison-batch
// handling exactly like an invalid merchant/provider/issuer id. Weights are
// each row's real `baseline_share`.
const CARD_DECLINE_MIX: readonly DeclineCode[] = [
  { code: "05", weight: 0.32, family: "issuer", diagnostic: true },
  { code: "51", weight: 0.26, family: "funds", diagnostic: false },
  { code: "54", weight: 0.11, family: "credential", diagnostic: false },
  { code: "01", weight: 0.08, family: "issuer", diagnostic: true },
  { code: "59", weight: 0.03, family: "fraud", diagnostic: true },
  { code: "57", weight: 0.03, family: "issuer", diagnostic: true },
  { code: "62", weight: 0.03, family: "issuer", diagnostic: true },
  { code: "1A", weight: 0.02, family: "auth", diagnostic: true },
  { code: "34", weight: 0.02, family: "fraud", diagnostic: true },
  { code: "63", weight: 0.02, family: "fraud", diagnostic: true },
  { code: "65", weight: 0.02, family: "auth", diagnostic: true },
  { code: "91", weight: 0.02, family: "network", diagnostic: true },
  { code: "14", weight: 0.015, family: "credential", diagnostic: false },
  { code: "04", weight: 0.01, family: "fraud", diagnostic: false },
  { code: "41", weight: 0.005, family: "fraud", diagnostic: false },
  { code: "43", weight: 0.005, family: "fraud", diagnostic: false },
  { code: "61", weight: 0.005, family: "funds", diagnostic: false },
];

const PIX_DECLINE_MIX: readonly DeclineCode[] = [
  { code: "AM05", weight: 0.55, family: "funds", diagnostic: false },
  { code: "AB03", weight: 0.15, family: "network", diagnostic: true },
  { code: "DS0G", weight: 0.10, family: "fraud", diagnostic: true },
  { code: "BE01", weight: 0.08, family: "credential", diagnostic: false },
  { code: "CH11", weight: 0.07, family: "credential", diagnostic: false },
  { code: "BE17", weight: 0.05, family: "merchant", diagnostic: true },
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
  overrideWeights: Readonly<Record<string, number>> = {},
  context?: DeclineMixContext,
): DeclineCode {
  const mix = declineMixFor(paymentMethod, context).map((entry) => ({
    ...entry,
    weight: overrideWeights[entry.code] ?? entry.weight,
  }));
  return pickWeighted(mix, random());
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
