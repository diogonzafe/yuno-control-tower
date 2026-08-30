import { describe, expect, it } from "vitest";

import { DEFAULT_STREAM_MAXLEN, emitTransaction } from "./emit.ts";

const event = {
  transactionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  merchantOrderId: "order-1",
  merchantId: "BR_STORE_01",
  providerId: "adyen",
  country: "BR",
  paymentMethod: "PIX",
  currency: "BRL",
  amountMinor: 1_000,
  fxRate: 0.18,
  fxRateDate: "2026-08-30",
  fxSource: "MOCK",
  amountUsdMinor: 180,
  status: "SUCCESS",
  issuerId: "NA",
  createdAt: "2026-08-30T12:00:00.000Z",
} as const;

function recordingClient() {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      xadd: async (...arguments_: unknown[]) => {
        calls.push(arguments_);
      },
    } as never,
  };
}

describe("emitTransaction", () => {
  it("writes a transaction as one Redis Stream event field", async () => {
    const { calls, client } = recordingClient();

    await emitTransaction(client, event);

    expect(calls).toHaveLength(1);
    const [stream, ...rest] = calls[0]!;
    expect(stream).toBe("stream:transactions");
    expect(rest.slice(-3, -1)).toEqual(["*", "payload"]);
    expect(JSON.parse(rest.at(-1) as string)).toEqual(event);
  });

  it("caps the stream so acked entries cannot grow it without bound", async () => {
    const { calls, client } = recordingClient();

    await emitTransaction(client, event);

    // XACK does not remove anything from a stream, and nothing in the app ever
    // XDELs or XTRIMs — without MAXLEN every transaction of the run stays in
    // Redis memory forever.
    expect(calls[0]!.slice(1, 4)).toEqual(["MAXLEN", "~", DEFAULT_STREAM_MAXLEN]);
  });

  it("takes the cap from the caller so it can be tuned per deployment", async () => {
    const { calls, client } = recordingClient();

    await emitTransaction(client, event, "stream:transactions", 1_000);

    expect(calls[0]!.slice(1, 4)).toEqual(["MAXLEN", "~", 1_000]);
  });
});
