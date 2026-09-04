import type { ConfirmedDrop } from "@control-tower/contracts";
import type { DeclineCode, DeclineRollupRow } from "./types.js";
import type { MerchantConfig, RollupRow, SliceFilter } from "../detect/types.js";

export const BUCKET = "2026-08-30T14:06:00.000Z";

export const BR_ROOT: SliceFilter = { merchantId: "BR_STORE_01", country: "BR" };

export const BR_CAUSAL: SliceFilter = {
  merchantId: "BR_STORE_01",
  providerId: "adyen",
  country: "BR",
  paymentMethod: "CARD",
  issuerId: "itau",
};

function brCard(providerId: string, issuerId: string, attempts: number, approved: number, bucket: string): RollupRow {
  return {
    bucket,
    merchantId: "BR_STORE_01",
    providerId,
    country: "BR",
    paymentMethod: "CARD",
    issuerId,
    attempts,
    approved,
    amountMinorSum: attempts * 50_000,
    amountUsdSum: attempts * 10_000,
    approvedUsdSum: approved * 10_000,
  };
}

// 3 providers x 3 issuers on BR/CARD. Every cell runs 100/95 except adyen x itau
// at 300/30. Root aggregate: 1100 attempts, 790 approved (rate 0.71818).
// Excluding the causal cell: 800 attempts, 760 approved (rate 0.95).
export function brCardGrid(bucket = BUCKET): RollupRow[] {
  const providers = ["stripe", "adyen", "mercado_pago"];
  const issuers = ["itau", "nubank", "bradesco"];
  return providers.flatMap((providerId) =>
    issuers.map((issuerId) =>
      providerId === "adyen" && issuerId === "itau"
        ? brCard(providerId, issuerId, 300, 30, bucket)
        : brCard(providerId, issuerId, 100, 95, bucket),
    ),
  );
}

function brPix(providerId: string, attempts: number, approved: number, bucket: string): RollupRow {
  return {
    bucket,
    merchantId: "BR_STORE_01",
    providerId,
    country: "BR",
    paymentMethod: "PIX",
    issuerId: "NA",
    attempts,
    approved,
    amountMinorSum: attempts * 10_000,
    amountUsdSum: attempts * 2_000,
    approvedUsdSum: approved * 2_000,
  };
}

// brCardGrid plus three healthy PIX cells (100/96). Root aggregate: 1400
// attempts, 1078 approved. Root deficit against 0.90 expected: 182 approvals,
// all of which the causal cell accounts for.
export function brFullGrid(bucket = BUCKET): RollupRow[] {
  return [
    ...brCardGrid(bucket),
    ...["stripe", "adyen", "mercado_pago"].map((providerId) => brPix(providerId, 100, 96, bucket)),
  ];
}

// Two disjoint causes under one root: adyen x itau at 300/30 and stripe x
// nubank at 200/20, every other card cell at 100/95, three healthy PIX cells.
// Root: 1500 attempts, 1003 approved, deficit 347 against 0.90 expected.
export function brTwoIncidentGrid(bucket = BUCKET): RollupRow[] {
  const providers = ["stripe", "adyen", "mercado_pago"];
  const issuers = ["itau", "nubank", "bradesco"];
  const card = providers.flatMap((providerId) =>
    issuers.map((issuerId) => {
      if (providerId === "adyen" && issuerId === "itau") return brCard(providerId, issuerId, 300, 30, bucket);
      if (providerId === "stripe" && issuerId === "nubank") return brCard(providerId, issuerId, 200, 20, bucket);
      return brCard(providerId, issuerId, 100, 95, bucket);
    }),
  );
  return [...card, ...providers.map((providerId) => brPix(providerId, 100, 96, bucket))];
}

export const DECLINE_CATALOG: DeclineCode[] = [
  { code: "05", paymentMethod: "CARD", family: "issuer", baselineShare: 0.32, diagnostic: true },
  { code: "51", paymentMethod: "CARD", family: "funds", baselineShare: 0.26, diagnostic: false },
  { code: "91", paymentMethod: "CARD", family: "network", baselineShare: 0.02, diagnostic: true },
  { code: "AM05", paymentMethod: "PIX", family: "funds", baselineShare: 0.55, diagnostic: false },
  { code: "AB03", paymentMethod: "PIX", family: "network", baselineShare: 0.15, diagnostic: true },
];

export function declineRow(overrides: Partial<DeclineRollupRow> = {}): DeclineRollupRow {
  return {
    bucket: BUCKET,
    merchantId: "BR_STORE_01",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    issuerId: "itau",
    declineCode: "05",
    count: 1,
    ...overrides,
  };
}

export function minutesBefore(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

export const MX_ROOT: SliceFilter = { merchantId: "MX_STORE_01", country: "MX" };

export const MX_CAUSAL: SliceFilter = {
  merchantId: "MX_STORE_01",
  country: "MX",
  issuerId: "bbva_mx",
};

// The briefing's second mandatory case: one Mexican issuer degrading for a
// single merchant, across every provider. MX has no PIX, so the issuer is a
// direct child of the root. Root: 900 attempts, 690 approved.
export function mxIssuerGrid(bucket = BUCKET): RollupRow[] {
  return ["stripe", "adyen", "mercado_pago"].flatMap((providerId) =>
    ["bbva_mx", "banorte", "citibanamex"].map((issuerId) => {
      const approved = issuerId === "bbva_mx" ? 40 : 95;
      return {
        bucket,
        merchantId: "MX_STORE_01",
        providerId,
        country: "MX" as const,
        paymentMethod: "CARD" as const,
        issuerId,
        attempts: 100,
        approved,
        amountMinorSum: 100 * 80_000,
        amountUsdSum: 100 * 4_000,
        approvedUsdSum: approved * 4_000,
      };
    }),
  );
}

export function confirmedDrop(dimensions: SliceFilter, bucket = BUCKET): ConfirmedDrop {
  return {
    dimensions: dimensions as ConfirmedDrop["dimensions"],
    windowBucket: bucket,
    observedRate: 0.7,
    expectedRate: 0.9,
    expectedSource: "absolute",
    deltaPp: 3,
    ciLow: 0.65,
    ciHigh: 0.75,
    ciLevel: 0.95,
    attempts: 1400,
    approved: 1078,
    windowUsed: "1m",
    startedAt: bucket,
    startedAtExact: false,
    consecutiveWindows: 3,
  };
}

export const DIAGNOSE_MERCHANTS: MerchantConfig[] = [
  { merchantId: "BR_STORE_01", expectedConversion: 0.9, minMaterialDropPp: 3 },
  { merchantId: "MX_STORE_01", expectedConversion: 0.91, minMaterialDropPp: 3 },
];

// Global degradation: nine card cells all sitting at 70% together. The root is
// materially down, yet no child stands out against its siblings, which is the
// shape that must end in INSUFFICIENT evidence rather than a forced answer.
export function brFlatDropGrid(bucket = BUCKET): RollupRow[] {
  return ["stripe", "adyen", "mercado_pago"].flatMap((providerId) =>
    ["itau", "nubank", "bradesco"].map((issuerId) => brCard(providerId, issuerId, 40, 28, bucket)),
  );
}

// Every cell at 200/178 (rate 0.89) — comfortably HEALTHY against the 0.9
// expected/3pp delta (limit 0.87), with n large enough that the Wilson
// interval's low bound clears 0.87 too. Models the single noisy tick a
// persistence-confirmed root can land on: this window alone reads fine even
// while the signal that triggered diagnosis stayed materially down.
export function brNoisyHealthyGrid(bucket = BUCKET): RollupRow[] {
  return ["stripe", "adyen", "mercado_pago"].flatMap((providerId) =>
    ["itau", "nubank", "bradesco"].map((issuerId) => brCard(providerId, issuerId, 200, 178, bucket)),
  );
}

// The jury's two-simultaneous-incidents scenario as production actually shapes
// it: disjoint CARD cells under one merchant, plus the healthy PIX book that
// carries three times a CARD route's traffic. That PIX volume is the whole
// point — it dilutes the merchant root until the deficit left by the moderate
// cause no longer reads as material there, which is what stopped the peel from
// finding it while the detector had already confirmed it.
export function brDualCauseWithPixGrid(bucket = BUCKET): RollupRow[] {
  const row = (providerId: string, issuerId: string, paymentMethod: "CARD" | "PIX", attempts: number, approved: number): RollupRow => ({
    bucket, merchantId: "BR_STORE_01", providerId, country: "BR", paymentMethod, issuerId,
    attempts, approved, amountMinorSum: 5000, amountUsdSum: 1000, approvedUsdSum: 950,
  });
  const card = ["stripe", "adyen", "mercado_pago"].flatMap((providerId) =>
    ["itau", "nubank", "bradesco"].map((issuerId) =>
      row(providerId, issuerId, "CARD", 76,
        providerId === "stripe" && issuerId === "itau" ? 2
          : providerId === "adyen" && issuerId === "nubank" ? 34
            : 68)));
  const pix = ["stripe", "adyen", "mercado_pago"].map((providerId) => row(providerId, "NA", "PIX", 228, 205));
  return [...card, ...pix];
}
