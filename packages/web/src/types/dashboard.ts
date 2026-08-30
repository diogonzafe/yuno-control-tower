export type HealthState = "MATERIAL_DROP" | "MONITORING" | "HEALTHY" | "INSUFFICIENT_EVIDENCE";

export type MerchantHealth = {
  name: string;
  id: string;
  countries: string[];
  triggerPp: number;
  expected: number;
  current: number;
  volumeUsd: number;
  exposurePerMinute: number;
  status: HealthState;
};

export type ProviderHealthRow = {
  countryMethod: string;
  cells: Partial<Record<string, { conversion: number; affectedMerchants: number }>>;
};

export type PortfolioSummary = {
  merchantsLive: number;
  merchantsFlagged: number;
  regionsCount: number;
  providersCount: number;
  portfolioConversion: number;
  conversionDeltaPp: number;
  attempts: number;
  attemptsDeltaPct: number;
  attemptsWindowMinutes: number;
  approvedVolumeUsd: number;
  approvedVolumeDeltaPct: number;
};

export type NavCounts = { portfolio: number; ingestion: number; alerts: number };
export type StreamStatus = { label: string; lagSeconds: number; messagesPerSecond: number };
export type CurrentUser = { name: string; role: string; initials: string };

export type Incident = {
  id: string;
  status: "OPEN" | "MONITORING" | "RESOLVED" | "INCONCLUSIVE";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  dimensions: string;
  affectedMerchants: number;
  startedAt: string;
  costPerMinute: number;
  recommendation: string;
  isSimulated?: boolean;
  evidence: IncidentEvidence;
};

export type IncidentEvidence = { observedRate: number; expectedRate: number; ciLow: number; ciHigh: number; testedDimensions: string[]; rootCause: string; suppressedEchoes: string[]; evidenceGap?: string };
export type InjectionInput = { merchant: string; provider: string; country: "BR" | "MX" | "AR"; paymentMethod: "CARD" | "PIX"; issuer: string; declineCode: string };

export type PipelineStage = { name: string; detail: string; status: "HEALTHY" | "DEGRADED" | "DOWN" };
export type IngestionBatch = { id: string; window: string; rows: number; durationMs: number; status: "OK" | "WARN" | "ERROR" };
export type PartitionLag = { partition: number; lagSeconds: number; throughput: number; status: "HEALTHY" | "DEGRADED" };
