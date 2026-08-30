import type { MerchantConfig, RollupRow, RoutingCoverage } from "./types.js";

export const PROVIDERS = ["stripe", "adyen", "mercado_pago"] as const;
export const MERCHANTS_BY_COUNTRY: Record<"BR" | "MX" | "AR", string[]> = {
  BR: ["BR_STORE_01", "BR_STORE_02", "BR_STORE_03"],
  MX: ["MX_STORE_01", "MX_STORE_02", "MX_STORE_03"],
  AR: ["AR_STORE_01", "AR_STORE_02", "AR_STORE_03"],
};
export const ISSUERS_BY_COUNTRY: Record<"BR" | "MX" | "AR", string[]> = {
  BR: ["itau", "nubank", "bradesco"],
  MX: ["bbva_mx", "banorte", "citibanamex"],
  AR: ["galicia", "santander_rio", "macro"],
};
export function countryOf(merchantId: string): "BR" | "MX" | "AR" {
  const prefix = merchantId.slice(0, 2);
  if (prefix === "BR" || prefix === "MX" || prefix === "AR") return prefix;
  throw new Error(`unknown merchant country for ${merchantId}`);
}
export function rollupRow(overrides: Partial<RollupRow> = {}): RollupRow {
  return { bucket: "2026-08-30T14:00:00.000Z", merchantId: "BR_STORE_01", providerId: "adyen", country: "BR", paymentMethod: "CARD", issuerId: "itau", attempts: 100, approved: 95, amountUsdSum: 1_000_000, approvedUsdSum: 950_000, ...overrides };
}
export function merchant(overrides: Partial<MerchantConfig> = {}): MerchantConfig {
  return { merchantId: "BR_STORE_01", expectedConversion: 0.9, minMaterialDropPp: 3.0, ...overrides };
}
export function fullCoverage(): RoutingCoverage {
  return PROVIDERS.flatMap((providerId) => [
    ...(["BR", "MX", "AR"] as const).map((country) => ({ providerId, country, paymentMethod: "CARD" })),
    { providerId, country: "BR", paymentMethod: "PIX" },
  ]);
}
