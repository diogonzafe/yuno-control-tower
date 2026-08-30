import { describe, expect, it } from "vitest";
import type { TransactionEvent } from "@control-tower/contracts";
import { parseEntries, type RawStreamEntry } from "./consumer";

function validPayload(overrides: Partial<TransactionEvent> = {}): string {
  return JSON.stringify({
    transactionId: "00000000-0000-4000-8000-000000000001",
    merchantOrderId: "order-1",
    merchantId: "merchant-1",
    providerId: "adyen",
    country: "BR",
    paymentMethod: "CARD",
    currency: "BRL",
    amountMinor: 1000,
    fxRate: 5,
    fxRateDate: "2026-08-30",
    fxSource: "MOCK",
    amountUsdMinor: 200,
    status: "SUCCESS",
    declineCode: null,
    rawDeclineCode: null,
    cardBrand: "visa",
    cardType: "credit",
    cardBin: "411111",
    issuerId: "itau",
    token: null,
    latencyMs: null,
    createdAt: "2026-08-30T14:03:00.000Z",
    ...overrides,
  });
}

describe("parseEntries", () => {
  it("parses a valid entry into the valid list", () => {
    const entries: RawStreamEntry[] = [["1-0", ["payload", validPayload()]]];

    const { valid, invalidIds } = parseEntries(entries);

    expect(valid).toHaveLength(1);
    expect(valid[0]?.id).toBe("1-0");
    expect(valid[0]?.event.transactionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(invalidIds).toEqual([]);
  });

  it("marks an entry with no payload field as invalid", () => {
    const entries: RawStreamEntry[] = [["1-0", ["someOtherField", "value"]]];

    const { valid, invalidIds } = parseEntries(entries);

    expect(valid).toEqual([]);
    expect(invalidIds).toEqual(["1-0"]);
  });

  it("marks an entry with invalid JSON as invalid", () => {
    const entries: RawStreamEntry[] = [["1-0", ["payload", "{not valid json"]]];

    const { valid, invalidIds } = parseEntries(entries);

    expect(valid).toEqual([]);
    expect(invalidIds).toEqual(["1-0"]);
  });

  it("marks an entry that fails schema validation as invalid", () => {
    const entries: RawStreamEntry[] = [
      ["1-0", ["payload", validPayload({ country: "US" as TransactionEvent["country"] })]],
    ];

    const { valid, invalidIds } = parseEntries(entries);

    expect(valid).toEqual([]);
    expect(invalidIds).toEqual(["1-0"]);
  });

  it("marks an entry violating a cross-field refine (DECLINED without declineCode) as invalid", () => {
    const entries: RawStreamEntry[] = [
      ["1-0", ["payload", validPayload({ status: "DECLINED", declineCode: null })]],
    ];

    const { valid, invalidIds } = parseEntries(entries);

    expect(valid).toEqual([]);
    expect(invalidIds).toEqual(["1-0"]);
  });

  it("separates valid and invalid entries in a mixed batch, preserving id order", () => {
    const entries: RawStreamEntry[] = [
      ["1-0", ["payload", validPayload()]],
      ["2-0", ["payload", "{not valid json"]],
      [
        "3-0",
        ["payload", validPayload({ transactionId: "00000000-0000-4000-8000-000000000003" })],
      ],
      ["4-0", ["someOtherField", "value"]],
    ];

    const { valid, invalidIds } = parseEntries(entries);

    expect(valid.map((entry) => entry.id)).toEqual(["1-0", "3-0"]);
    expect(invalidIds).toEqual(["2-0", "4-0"]);
  });

  it("returns empty results for an empty batch", () => {
    const { valid, invalidIds } = parseEntries([]);

    expect(valid).toEqual([]);
    expect(invalidIds).toEqual([]);
  });
});
