import { transactionEventSchema, type TransactionEvent } from "@control-tower/contracts";

import { applyIncidents, type GeneratorIncident } from "./incident.ts";
import { declineCodeFor, type CardBrand, type PaymentMethod } from "./mix.ts";
import { createLogger } from "./logging.js";

// TEMP DEBUG — verifying whether an active incident's multiplier is actually
// reaching generateTransaction for every matching cell, or only some calls.
const debugLogger = createLogger("transaction-debug");
const applyTally = {
  multiplierApplied: 0,
  multiplierNotApplied: 0,
  incidentsSeenCount: new Map<number, number>(),
  thresholdSeen: new Map<string, number>(),
  approvedUnderIncident: 0,
  declinedUnderIncident: 0,
};
let applyTallyTimer: ReturnType<typeof setInterval> | null = null;

type Country = "AR" | "MX" | "BR";

export type TransactionCell = {
  merchantId: string;
  providerId: string;
  country: Country;
  paymentMethod: PaymentMethod;
  issuerId: string;
  baselineConversion: number;
};

export type TransactionRandom = { next: () => number };

export type GenerateTransactionInput = {
  random: TransactionRandom;
  transactionId: string;
  merchantOrderId: string;
  createdAt: string;
  cell: TransactionCell;
  amountMinor: number;
  incidents?: readonly GeneratorIncident[];
};

const CURRENCY_BY_COUNTRY: Readonly<Record<Country, "ARS" | "MXN" | "BRL">> = {
  AR: "ARS",
  MX: "MXN",
  BR: "BRL",
};

// Mock daily rates are frozen onto the event as required by DD9.
const USD_PER_LOCAL_MINOR: Readonly<Record<Country, number>> = {
  AR: 0.001,
  MX: 0.055,
  BR: 0.18,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function generateTransaction(input: GenerateTransactionInput): TransactionEvent {
  validateInput(input);

  const { cell } = input;
  const effects = applyIncidents(input.incidents ?? [], {
    at: input.createdAt,
    merchantId: cell.merchantId,
    providerId: cell.providerId,
    country: cell.country,
    paymentMethod: cell.paymentMethod,
    issuerId: cell.issuerId,
  });

  // TEMP DEBUG
  if (cell.country === "BR" && cell.paymentMethod === "CARD") {
    if (effects.conversionMultiplier < 1) applyTally.multiplierApplied += 1;
    else applyTally.multiplierNotApplied += 1;
    const n = (input.incidents ?? []).length;
    applyTally.incidentsSeenCount.set(n, (applyTally.incidentsSeenCount.get(n) ?? 0) + 1);
    const key = `${cell.baselineConversion}*${effects.conversionMultiplier}`;
    applyTally.thresholdSeen.set(key, (applyTally.thresholdSeen.get(key) ?? 0) + 1);
    if (applyTallyTimer === null) {
      applyTallyTimer = setInterval(() => {
        debugLogger.error(
          {
            at: new Date().toISOString(),
            multiplierApplied: applyTally.multiplierApplied,
            multiplierNotApplied: applyTally.multiplierNotApplied,
            incidentsSeenCount: Object.fromEntries(applyTally.incidentsSeenCount),
            thresholdSeen: Object.fromEntries(applyTally.thresholdSeen),
            approvedUnderIncident: applyTally.approvedUnderIncident,
            declinedUnderIncident: applyTally.declinedUnderIncident,
          },
          "DEBUG_APPLY_TALLY",
        );
      }, 5_000);
      applyTallyTimer.unref?.();
    }
  }

  const cardBrand = cell.paymentMethod === "CARD" ? cardBrandFor(cell.country, input.random.next()) : null;
  const approved = input.random.next() < cell.baselineConversion * effects.conversionMultiplier;

  // TEMP DEBUG
  if (cell.country === "BR" && cell.paymentMethod === "CARD" && effects.conversionMultiplier < 1) {
    if (approved) applyTally.approvedUnderIncident += 1;
    else applyTally.declinedUnderIncident += 1;
  }

  const decline = approved
    ? null
    : declineCodeFor(
      cell.paymentMethod,
      input.random.next.bind(input.random),
      effects.declineWeights,
      { country: cell.country, issuerId: cell.issuerId },
    );
  const fxRate = USD_PER_LOCAL_MINOR[cell.country];

  return transactionEventSchema.parse({
    transactionId: input.transactionId,
    merchantOrderId: input.merchantOrderId,
    merchantId: cell.merchantId,
    providerId: cell.providerId,
    country: cell.country,
    paymentMethod: cell.paymentMethod,
    currency: CURRENCY_BY_COUNTRY[cell.country],
    amountMinor: input.amountMinor,
    fxRate,
    fxRateDate: input.createdAt.slice(0, 10),
    fxSource: "MOCK",
    amountUsdMinor: Math.round(input.amountMinor * fxRate),
    status: approved ? "SUCCESS" : "DECLINED",
    declineCode: decline?.code ?? null,
    // The seeded decline_codes catalog IS the raw network code (ISO 8583 for
    // CARD, SPI return code for PIX) — there is no separate, more granular
    // "raw" representation available, so both fields carry the same value.
    rawDeclineCode: decline?.code ?? null,
    cardBrand,
    cardType: cell.paymentMethod === "CARD" ? (input.random.next() < 0.7 ? "credit" : "debit") : null,
    cardBin: cell.paymentMethod === "CARD" ? cardBinFor(cardBrand!, input.random.next()) : null,
    issuerId: cell.issuerId,
    token: cell.paymentMethod === "CARD" ? `tok_${input.transactionId.replaceAll("-", "")}` : null,
    latencyMs: baselineLatencyMs(cell.paymentMethod) + effects.latencyMsIncrease,
    createdAt: input.createdAt,
  });
}

function validateInput(input: GenerateTransactionInput): void {
  if (!UUID_PATTERN.test(input.transactionId)) {
    throw new Error("transactionId must be a UUID");
  }
  if (input.merchantOrderId.length === 0
    || input.cell.merchantId.length === 0
    || input.cell.providerId.length === 0
    || input.cell.issuerId.length === 0) {
    throw new Error("transaction identifiers must be non-empty");
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new Error("amountMinor must be a non-negative integer");
  }
  if (!Number.isFinite(input.cell.baselineConversion)
    || input.cell.baselineConversion < 0
    || input.cell.baselineConversion > 1) {
    throw new Error("baselineConversion must be between zero and one");
  }
  if (input.cell.paymentMethod === "PIX"
    && (input.cell.country !== "BR" || input.cell.issuerId !== "NA")) {
    throw new Error("PIX requires country BR and issuerId NA");
  }
  if (input.cell.paymentMethod === "CARD" && input.cell.issuerId === "NA") {
    throw new Error("CARD requires a concrete issuerId");
  }
  if (!ISO_TIMESTAMP_WITH_OFFSET.test(input.createdAt) || Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error("createdAt must be an ISO timestamp with an offset");
  }
}

function cardBrandFor(country: Country, random: number): CardBrand {
  if (country !== "BR") return random < 0.55 ? "Visa" : "Mastercard";
  if (random < 0.5) return "Visa";
  if (random < 0.9) return "Mastercard";
  return "Elo";
}

function cardBinFor(cardBrand: CardBrand, random: number): string {
  const prefix = cardBrand === "Visa" ? "4" : cardBrand === "Mastercard" ? "5" : "6";
  return `${prefix}${Math.floor(random * 100_000).toString().padStart(5, "0")}`;
}

function baselineLatencyMs(paymentMethod: PaymentMethod): number {
  return paymentMethod === "PIX" ? 180 : 120;
}
