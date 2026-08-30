export type Dimension = "merchantId" | "providerId" | "country" | "paymentMethod" | "issuerId";
export type SliceFilter = Partial<Record<Dimension, string>>;
export type RollupRow = { bucket: string; merchantId: string; providerId: string; country: "BR" | "MX" | "AR"; paymentMethod: "CARD" | "PIX"; issuerId: string; attempts: number; approved: number; amountUsdSum: number; approvedUsdSum: number };
export type MerchantConfig = { merchantId: string; expectedConversion: number; minMaterialDropPp: number };
export type RoutingCoverage = Array<{ providerId: string; country: string; paymentMethod: string }>;
