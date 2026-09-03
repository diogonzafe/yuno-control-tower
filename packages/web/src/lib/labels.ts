// The decline_codes catalog seed carries a mix of English and Portuguese
// descriptions. This overrides them for display only — the database rows are
// shared infrastructure and are left untouched.
export const DECLINE_CODE_LABELS: Record<string, string> = {
  "01": "Refer to card issuer",
  "04": "Pick up card",
  "05": "Do not honor",
  "14": "Invalid card number",
  "1A": "Authentication required (SCA)",
  "34": "Suspected fraud (pick up)",
  "41": "Lost card",
  "43": "Stolen card",
  "51": "Insufficient funds or limit",
  "54": "Expired card",
  "57": "Transaction not permitted to cardholder",
  "59": "Suspected fraud",
  "61": "Amount or usage limit exceeded",
  "62": "Restricted card",
  "63": "Security violation",
  "65": "Authentication required (attempts exceeded)",
  "91": "Issuer unavailable",
  AB03: "SPI timeout",
  AM05: "Insufficient funds",
  BE01: "CPF/CNPJ mismatch",
  BE17: "Receiver rejected (inactive account)",
  CH11: "Invalid payer identification",
  DS0G: "Transaction not authorized (fraud prevention)",
};

export function declineCodeLabel(code: string): string {
  return DECLINE_CODE_LABELS[code] ?? code;
}

// DecisionTag from @control-tower/contracts is a screaming-snake-case enum
// (HYPOTHESIS, DRILL_DOWN, ...) meant for machine matching; this turns it
// into the short label the drill-down trail actually shows a human.
export function decisionTagLabel(tag: string): string {
  return tag.charAt(0) + tag.slice(1).toLowerCase().replace(/_/g, " ");
}

export const DIMENSION_LABELS: Record<string, string> = {
  merchantId: "Merchant",
  providerId: "Provider",
  country: "Country",
  paymentMethod: "Method",
  issuerId: "Issuer",
};

export const COUNTRY_NAMES: Record<string, string> = { BR: "Brazil", MX: "Mexico", AR: "Argentina" };

export const CAUSAL_DIMENSION_LABELS: Record<string, string> = {
  provider: "provider",
  issuer: "issuer",
  method: "payment method",
  merchant: "merchant",
};

// ExpectedSource from @control-tower/contracts — what the "expected" rate in
// a Wilson comparison was actually computed against.
export const EXPECTED_SOURCE_HINTS: Record<string, string> = {
  cross_sectional: "Expected rate is the same-window rate of the cell's peers (other providers/issuers active right now) — rules out a rate that's just normally low for the hour.",
  temporal: "Expected rate is this same cell's own recent history — used when there's no comparable peer cell to benchmark against.",
  absolute: "Expected rate is a fixed floor set for this dimension — used when neither a peer cell nor recent history gives a reliable baseline.",
};

export function expectedSourceHint(source: string): string {
  return EXPECTED_SOURCE_HINTS[source] ?? "How the expected rate for this comparison was derived.";
}

export const PLAYBOOKS: Record<string, { id: string; title: string; body: string }> = {
  issuer: {
    id: "PB-ISSUER-01",
    title: "Route traffic away from this issuer to an alternate provider",
    body: "The decline originates at the issuer. Route attempts for this BIN range to the provider with the best approval rate in the same cell, and open a line with the bank. Reversible in one click once the dominant code's share returns to its normal mix.",
  },
  provider: {
    id: "PB-PROVIDER-01",
    title: "Fail the affected traffic over to the sibling providers",
    body: "The concentration crosses issuers, which points to the provider losing connectivity. Shift the cell's traffic to the remaining providers and monitor latency before routing back.",
  },
  method: {
    id: "PB-METHOD-01",
    title: "Communicate the degradation and reduce exposure",
    body: "The failure is in the rail, not the platform — it shows up identically across every provider. There is no owner inside the system's scope; prioritize communicating with the merchant and offering an alternate method at checkout.",
  },
  merchant: {
    id: "PB-MERCHANT-01",
    title: "Review the receiving account and the merchant's risk rules",
    body: "The drop is contained to a single merchant, which rules out provider and issuer. Check receiving details and recent anti-fraud rule changes before any routing change.",
  },
};
