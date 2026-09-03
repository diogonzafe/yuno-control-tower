import type { Catalog, IncidentRow, PortfolioPoint, ProviderMinutePoint } from "@control-tower/app";
import type { EvidenceObject, PendingSignal } from "@control-tower/contracts";

// Hand-built, contract-shaped sample data used only when NEXT_PUBLIC_USE_FIXTURES=true.
// Lets the History/status-badge UI be developed and eyeballed without the
// orchestrator (packages/app/src/orchestrate/*, being rebuilt on `dev`)
// ever having written a row into `incidents`.

function evidence(overrides: Partial<EvidenceObject> & Pick<EvidenceObject, "fingerprint" | "dimensions">): EvidenceObject {
  return {
    observedRate: 0.12,
    expectedRate: 0.7,
    expectedSource: "cross_sectional",
    deltaPp: 3,
    ci: { low: 0.08, high: 0.17, level: 0.95 },
    attempts: 420,
    approved: 50,
    windowBucket: "2026-08-30T14:06:00.000Z",
    windowUsed: "1m",
    consecutiveWindows: 3,
    startedAt: "2026-08-30T14:03:00.000Z",
    startedAtExact: true,
    declineMix: [{ code: "05", family: "issuer", observedShare: 0.78, baselineShare: 0.32, count: 289 }],
    dominantDecline: "05",
    suppressedEchoes: [],
    lostApprovals: 244,
    costUsdMinor: 380_000,
    costUsdPerMin: 3_800,
    costLocal: { BRL: 128_400_00 },
    priorityScore: 91.4,
    diagnosisSource: "beam_search",
    investigationTrail: [],
    ...overrides,
  };
}

export const FIXTURE_CATALOG: Catalog = {
  merchants: [
    { id: "BR_STORE_01", name: "BR Store 01" },
    { id: "MX_STORE_01", name: "MX Store 01" },
  ],
  providers: [
    { id: "adyen", name: "Adyen" },
    { id: "dlocal", name: "dLocal" },
  ],
  issuers: [
    { id: "itau", name: "Itaú", country: "BR" },
    { id: "NA", name: "N/A", country: null },
  ],
};

const openIncident: IncidentRow = {
  incidentId: "fixture-open-1",
  fingerprint: "country=BR|providerId=adyen",
  status: "open",
  startedAt: "2026-08-30T14:03:00.000Z",
  detectedAt: "2026-08-30T14:06:00.000Z",
  resolvedAt: null,
  costUsdPerMin: 3_800,
  evidence: evidence({
    fingerprint: "country=BR|providerId=adyen",
    dimensions: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen", issuerId: "itau" },
  }),
};

const monitoringIncident: IncidentRow = {
  incidentId: "fixture-monitoring-1",
  fingerprint: "country=MX|providerId=dlocal",
  status: "monitoring",
  startedAt: "2026-08-30T13:40:00.000Z",
  detectedAt: "2026-08-30T13:50:00.000Z",
  resolvedAt: null,
  costUsdPerMin: 900,
  evidence: evidence({
    fingerprint: "country=MX|providerId=dlocal",
    dimensions: { merchantId: "MX_STORE_01", country: "MX", providerId: "dlocal" },
    observedRate: 0.62,
    expectedRate: 0.7,
    ci: { low: 0.58, high: 0.66, level: 0.95 },
    costUsdMinor: 45_000,
    costUsdPerMin: 900,
    costLocal: { MXN: 8_200_00 },
  }),
};

const resolvedIncident: IncidentRow = {
  incidentId: "fixture-resolved-1",
  fingerprint: "country=BR|paymentMethod=PIX",
  status: "resolved",
  startedAt: "2026-08-30T11:10:00.000Z",
  detectedAt: "2026-08-30T11:20:00.000Z",
  resolvedAt: "2026-08-30T12:05:00.000Z",
  costUsdPerMin: 2_100,
  evidence: evidence({
    fingerprint: "country=BR|paymentMethod=PIX",
    dimensions: { country: "BR", paymentMethod: "PIX" },
    costUsdMinor: 210_000,
    costUsdPerMin: 2_100,
    costLocal: { BRL: 70_900_00 },
  }),
};

const inconclusiveIncident: IncidentRow = {
  incidentId: "fixture-inconclusive-1",
  fingerprint: "providerId=dlocal|issuerId=NA",
  status: "inconclusive",
  startedAt: "2026-08-30T10:00:00.000Z",
  detectedAt: "2026-08-30T10:04:00.000Z",
  resolvedAt: null,
  costUsdPerMin: 400,
  evidence: evidence({
    fingerprint: "providerId=dlocal|issuerId=NA",
    dimensions: { providerId: "dlocal", issuerId: "NA" },
    attempts: 41,
    approved: 30,
    costUsdMinor: 4_000,
    costUsdPerMin: 400,
    costLocal: { MXN: 900_00 },
  }),
};

const providerSeries: ProviderMinutePoint[] = [
  { bucket: "2026-08-30T14:00:00.000Z", providerId: "adyen", attempts: 300, approved: 250 },
  { bucket: "2026-08-30T14:01:00.000Z", providerId: "adyen", attempts: 310, approved: 130 },
  { bucket: "2026-08-30T14:00:00.000Z", providerId: "dlocal", attempts: 180, approved: 160 },
  { bucket: "2026-08-30T14:01:00.000Z", providerId: "dlocal", attempts: 175, approved: 158 },
];

const portfolioSeries: PortfolioPoint[] = [
  { bucket: "2026-08-30T14:00:00.000Z", attempts: 480, approved: 410 },
  { bucket: "2026-08-30T14:01:00.000Z", attempts: 485, approved: 288 },
];

const pendingSignals: PendingSignal[] = [
  {
    dimensions: { merchantId: "BR_STORE_02", country: "BR", paymentMethod: "CARD" },
    windowBucket: "2026-08-30T14:06:00.000Z",
    observedRate: 0.58,
    expectedRate: 0.9,
    expectedSource: "cross_sectional",
    deltaPp: 3,
    ciLow: 0.5,
    ciHigh: 0.66,
    ciLevel: 0.95,
    attempts: 96,
    approved: 56,
    windowUsed: "1m",
    firstBucket: "2026-08-30T14:05:00.000Z",
    windowsConfirmed: 1,
    windowsRequired: 2,
  },
];

export const FIXTURE_SNAPSHOT = {
  incidents: [openIncident, monitoringIncident, resolvedIncident, inconclusiveIncident],
  providerSeries,
  portfolioSeries,
  pendingSignals,
  generatedAt: "2026-08-30T14:06:00.000Z",
};
