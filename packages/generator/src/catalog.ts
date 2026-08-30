import type { PaymentMethod } from "./mix.ts";
import { createSeededRandom, type SeededRandom } from "./random.ts";
import type { TransactionCell } from "./transaction.ts";

export type Country = "AR" | "MX" | "BR";

export type Merchant = {
  merchantId: string;
  name: string;
  country: Country;
  expectedConversion: number;
};

export type MerchantIdentity = { merchantId: string; name: string; country: Country };

export type BuildGeneratorCatalogOptions = {
  /** Applied to every merchant unless `randomizeConversion` is set. Default 0.90. */
  defaultConversion?: number;
  /** When true, each merchant's conversion is `defaultConversion` +/- 0.05 instead of the exact value. */
  randomizeConversion?: boolean;
  random?: SeededRandom;
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
  { providerId: "mercado_pago", name: "Mercado Pago" },
] as const;

// Every id below mirrors the real, seeded rows in the shared Postgres catalog
// (merchants, providers, issuer_banks, routing_coverage) — transactions
// carries NOT NULL foreign keys into those tables, so an id that doesn't exist
// there is silently dropped by the ingestion consumer's poison-batch handling.
// Merchants are country-scoped (BR_STORE_01 never trades in AR or MX): 9
// merchants x their own country's routes reproduces DD13's 90 cells exactly.
const merchantIdentities: readonly MerchantIdentity[] = [
  { merchantId: "AR_STORE_01", name: "Pampa Digital", country: "AR" },
  { merchantId: "AR_STORE_02", name: "Rivera Tienda", country: "AR" },
  { merchantId: "AR_STORE_03", name: "Andes Mercado", country: "AR" },
  { merchantId: "BR_STORE_01", name: "Aurora Marketplace", country: "BR" },
  { merchantId: "BR_STORE_02", name: "Vitrine Prime", country: "BR" },
  { merchantId: "BR_STORE_03", name: "Rota Sul Comercio", country: "BR" },
  { merchantId: "MX_STORE_01", name: "Sol Azteca Retail", country: "MX" },
  { merchantId: "MX_STORE_02", name: "Delta Norte Shop", country: "MX" },
  { merchantId: "MX_STORE_03", name: "Casa Maya Online", country: "MX" },
];

const issuerIdentities: readonly Issuer[] = [
  { issuerId: "itau", name: "Itau", country: "BR" },
  { issuerId: "nubank", name: "Nubank", country: "BR" },
  { issuerId: "bradesco", name: "Bradesco", country: "BR" },
  { issuerId: "bbva_mx", name: "BBVA Mexico", country: "MX" },
  { issuerId: "banorte", name: "Banorte", country: "MX" },
  { issuerId: "citibanamex", name: "Citibanamex", country: "MX" },
  { issuerId: "galicia", name: "Galicia", country: "AR" },
  { issuerId: "santander_rio", name: "Santander Rio", country: "AR" },
  { issuerId: "macro", name: "Macro", country: "AR" },
];

const routingCoverage: readonly RoutingCoverage[] = providers.flatMap((provider) => [
  { providerId: provider.providerId, country: "AR" as const, paymentMethod: "CARD" as const },
  { providerId: provider.providerId, country: "MX" as const, paymentMethod: "CARD" as const },
  { providerId: provider.providerId, country: "BR" as const, paymentMethod: "CARD" as const },
  { providerId: provider.providerId, country: "BR" as const, paymentMethod: "PIX" as const },
]);

const DEFAULT_CONVERSION = 0.90;
const CONVERSION_RANDOMIZATION_SPREAD = 0.05;

// The merchant-level expected conversion is parameterized (never hardcoded
// per merchant) — see GENERATOR_DEFAULT_CONVERSION / GENERATOR_RANDOMIZE_CONVERSION
// in run.ts. Merchant identity (id, name, country) stays fixed: those are the
// real seeded catalog rows, not a tunable.
export function buildGeneratorCatalog(options: BuildGeneratorCatalogOptions = {}): GeneratorCatalog {
  const base = options.defaultConversion ?? DEFAULT_CONVERSION;
  if (!Number.isFinite(base) || base <= 0 || base >= 1) {
    throw new Error("defaultConversion must be a probability strictly between 0 and 1");
  }
  const randomize = options.randomizeConversion ?? false;
  const random = options.random ?? createSeededRandom(Date.now());

  return {
    merchants: merchantIdentities.map((identity) => ({
      ...identity,
      expectedConversion: randomize ? randomizedConversion(base, random) : base,
    })),
    providers,
    issuers: issuerIdentities,
    routingCoverage,
  };
}

function randomizedConversion(base: number, random: SeededRandom): number {
  const offset = (random.next() * 2 - 1) * CONVERSION_RANDOMIZATION_SPREAD;
  return Math.min(0.99, Math.max(0.5, base + offset));
}

export function buildTransactionCells(
  catalog: GeneratorCatalog,
  merchantTrafficWeights: MerchantTrafficWeights,
): readonly WeightedTransactionCell[] {
  validateCatalog(catalog, merchantTrafficWeights);
  const cells: WeightedTransactionCell[] = [];
  const weightUnitsByCountry = new Map<Country, number>();

  for (const merchant of catalog.merchants) {
    // A merchant only ever trades in its own country — a BR merchant has no
    // AR or MX routes, matching the seeded catalog's country-scoped ids.
    const merchantRoutes = catalog.routingCoverage.filter((route) => route.country === merchant.country);
    let merchantWeightUnits = weightUnitsByCountry.get(merchant.country);
    if (merchantWeightUnits === undefined) {
      merchantWeightUnits = weightUnitsFor(catalog, merchantRoutes);
      weightUnitsByCountry.set(merchant.country, merchantWeightUnits);
    }

    for (const route of merchantRoutes) {
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

function weightUnitsFor(catalog: GeneratorCatalog, routes: readonly RoutingCoverage[]): number {
  return routes.reduce((count, route) =>
    count + methodTrafficMultiplier(route.paymentMethod)
      * (route.paymentMethod === "PIX" ? 1 : catalog.issuers.filter((issuer) => issuer.country === route.country).length), 0);
}

function validateCatalog(catalog: GeneratorCatalog, merchantTrafficWeights: MerchantTrafficWeights): void {
  if (catalog.merchants.length !== 9 || catalog.providers.length !== 3 || catalog.issuers.length !== 9) {
    throw new Error("catalog must contain 9 merchants (3 per country), 3 providers, and 3 issuers per country");
  }
  if (catalog.routingCoverage.length !== 12) {
    throw new Error("routingCoverage must contain the 12 DD13 routes");
  }
  for (const country of ["AR", "MX", "BR"] as const) {
    if (catalog.merchants.filter((merchant) => merchant.country === country).length !== 3) {
      throw new Error(`catalog must contain exactly 3 merchants for ${country}`);
    }
    if (catalog.issuers.filter((issuer) => issuer.country === country).length !== 3) {
      throw new Error(`catalog must contain exactly 3 issuers for ${country}`);
    }
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
