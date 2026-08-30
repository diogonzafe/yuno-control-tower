import type { PaymentMethod } from "./mix.ts";
import type { TransactionCell } from "./transaction.ts";

export type Country = "AR" | "MX" | "BR";

export type Merchant = {
  merchantId: string;
  name: string;
  expectedConversion: number;
};

export type MerchantTrafficWeights = Readonly<Record<string, number>>;

export type Provider = { providerId: string; name: string };
export type Issuer = { issuerId: string; name: string; country: Country };
export type RoutingCoverage = {
  providerId: string;
  country: Country;
  paymentMethod: PaymentMethod;
};

export type GeneratorCatalog = {
  merchants: readonly Merchant[];
  providers: readonly Provider[];
  issuers: readonly Issuer[];
  routingCoverage: readonly RoutingCoverage[];
};

export type WeightedTransactionCell = TransactionCell & { trafficWeight: number };

const providers = [
  { providerId: "stripe", name: "Stripe" },
  { providerId: "adyen", name: "Adyen" },
  { providerId: "mercado-pago", name: "Mercado Pago" },
] as const;

export const defaultGeneratorCatalog: GeneratorCatalog = {
  merchants: [
    { merchantId: "merchant-a", name: "Merchant A", expectedConversion: 0.92 },
    { merchantId: "merchant-b", name: "Merchant B", expectedConversion: 0.92 },
    { merchantId: "merchant-c", name: "Merchant C", expectedConversion: 0.92 },
  ],
  providers,
  issuers: [
    { issuerId: "itau", name: "Itaú", country: "BR" },
    { issuerId: "nubank", name: "Nubank", country: "BR" },
    { issuerId: "bradesco", name: "Bradesco", country: "BR" },
    { issuerId: "bbva-mexico", name: "BBVA México", country: "MX" },
    { issuerId: "banorte", name: "Banorte", country: "MX" },
    { issuerId: "citibanamex", name: "Citibanamex", country: "MX" },
    { issuerId: "galicia", name: "Galicia", country: "AR" },
    { issuerId: "santander-rio", name: "Santander Río", country: "AR" },
    { issuerId: "macro", name: "Macro", country: "AR" },
  ],
  routingCoverage: providers.flatMap((provider) => [
    { providerId: provider.providerId, country: "AR" as const, paymentMethod: "CARD" as const },
    { providerId: provider.providerId, country: "MX" as const, paymentMethod: "CARD" as const },
    { providerId: provider.providerId, country: "BR" as const, paymentMethod: "CARD" as const },
    { providerId: provider.providerId, country: "BR" as const, paymentMethod: "PIX" as const },
  ]),
};

export function buildTransactionCells(
  catalog: GeneratorCatalog,
  merchantTrafficWeights: MerchantTrafficWeights,
): readonly WeightedTransactionCell[] {
  validateCatalog(catalog, merchantTrafficWeights);
  const cells: WeightedTransactionCell[] = [];

  for (const merchant of catalog.merchants) {
    const merchantWeightUnits = weightUnitsForMerchant(catalog);
    for (const route of catalog.routingCoverage) {
      const issuers = route.paymentMethod === "PIX"
        ? ["NA"]
        : catalog.issuers.filter((issuer) => issuer.country === route.country).map((issuer) => issuer.issuerId);
      for (const issuerId of issuers) {
        cells.push({
          merchantId: merchant.merchantId,
          providerId: route.providerId,
          country: route.country,
          paymentMethod: route.paymentMethod,
          issuerId,
          baselineConversion: baselineConversionFor(merchant.expectedConversion, route),
          trafficWeight: merchantTrafficWeights[merchant.merchantId]! * methodTrafficMultiplier(route.paymentMethod) / merchantWeightUnits,
        });
      }
    }
  }

  return cells;
}

function weightUnitsForMerchant(catalog: GeneratorCatalog): number {
  return catalog.routingCoverage.reduce((count, route) =>
    count + methodTrafficMultiplier(route.paymentMethod)
      * (route.paymentMethod === "PIX" ? 1 : catalog.issuers.filter((issuer) => issuer.country === route.country).length), 0);
}

function validateCatalog(catalog: GeneratorCatalog, merchantTrafficWeights: MerchantTrafficWeights): void {
  if (catalog.merchants.length !== 3 || catalog.providers.length !== 3 || catalog.issuers.length !== 9) {
    throw new Error("catalog must contain 3 merchants, 3 providers, and 3 issuers per country");
  }
  if (catalog.routingCoverage.length !== 12) {
    throw new Error("routingCoverage must contain the 12 DD13 routes");
  }
  if (catalog.issuers.some((issuer) => catalog.issuers.filter((candidate) => candidate.country === issuer.country).length !== 3)) {
    throw new Error("catalog must contain exactly 3 issuers for every country");
  }
  if (catalog.routingCoverage.some((route) => route.paymentMethod === "PIX" && route.country !== "BR")) {
    throw new Error("PIX routing coverage is only valid in BR");
  }
  if (catalog.merchants.some((merchant) => merchant.expectedConversion <= 0 || merchant.expectedConversion > 1)) {
    throw new Error("merchant expectedConversion must be a positive probability");
  }
  if (catalog.merchants.some((merchant) => !Number.isFinite(merchantTrafficWeights[merchant.merchantId])
    || merchantTrafficWeights[merchant.merchantId]! <= 0)) {
    throw new Error("merchant traffic weights must be provided by the caller");
  }
}

function baselineConversionFor(expectedConversion: number, route: RoutingCoverage): number {
  const offset = route.paymentMethod === "PIX" ? 0.05
    : route.country === "AR" ? -0.01
      : route.country === "MX" ? -0.04
        : 0;
  return expectedConversion + offset;
}

function methodTrafficMultiplier(paymentMethod: PaymentMethod): number {
  return paymentMethod === "PIX" ? 3 : 1;
}
