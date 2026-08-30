import type { CurrentUser, NavCounts, PortfolioSummary, ProviderHealthRow, StreamStatus } from "../types/dashboard";
import { incidents } from "./alerts-data";
import { pipelineStages } from "./ingestion-data";

// Temporary presentation fixture. API/SSE wiring belongs here once packages/app exposes it.
export const dashboardSummary: PortfolioSummary = {
  merchantsLive: 61,
  merchantsFlagged: 8,
  regionsCount: 3,
  providersCount: 14,
  portfolioConversion: 81.9,
  conversionDeltaPp: -2.4,
  attempts: 486000,
  attemptsDeltaPct: 3.2,
  attemptsWindowMinutes: 360,
  approvedVolumeUsd: 18400000,
  approvedVolumeDeltaPct: -4.1,
};

export const currentUser: CurrentUser = { name: "Mariana Reis", role: "Payment Ops", initials: "MR" };
export const streamStatus: StreamStatus = { label: "rollup_minute", lagSeconds: 1.8, messagesPerSecond: 41 };
export const navCounts: NavCounts = {
  portfolio: dashboardSummary.merchantsLive,
  ingestion: pipelineStages.filter((stage) => stage.status !== "HEALTHY").length,
  alerts: incidents.filter((incident) => incident.status === "OPEN").length,
};

export const providers = ["Adyen", "dLocal", "Stripe", "Yuno Pix"];

export const providerHealthRows: ProviderHealthRow[] = [
  { countryMethod: "BR · CARD", cells: { Adyen: { conversion: 61, affectedMerchants: 4 }, dLocal: { conversion: 83, affectedMerchants: 0 }, Stripe: { conversion: 84, affectedMerchants: 0 } } },
  { countryMethod: "BR · PIX", cells: { "Yuno Pix": { conversion: 96, affectedMerchants: 0 } } },
  { countryMethod: "MX · CARD", cells: { Adyen: { conversion: 82, affectedMerchants: 0 }, dLocal: { conversion: 76, affectedMerchants: 1 }, Stripe: { conversion: 81, affectedMerchants: 0 } } },
  { countryMethod: "AR · CARD", cells: { dLocal: { conversion: 75, affectedMerchants: 1 }, Stripe: { conversion: 70, affectedMerchants: 1 } } },
];
