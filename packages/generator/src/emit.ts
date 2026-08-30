import { transactionEventSchema, type TransactionEvent } from "@control-tower/contracts";

// XACK marks an entry as processed for the consumer group; it does not remove
// it. Nothing in the app XDELs or XTRIMs, so an uncapped stream keeps every
// transaction of the run in Redis memory for as long as the instance lives.
// ~ makes the trim approximate: Redis drops whole nodes at its own convenience
// instead of walking to an exact length on every XADD, which is what keeps the
// cap off the hot path. The real length stays within a node of the cap.
// 200k is ~2.5 hours of headroom at the generator's ~24 tx/s average — far more
// than the ingest consumer can fall behind before the backlog is the problem.
export const DEFAULT_STREAM_MAXLEN = 200_000;

export type RedisStreamClient = {
  xadd: (
    stream: string,
    strategy: "MAXLEN",
    approximate: "~",
    maxLength: number,
    id: "*",
    field: "payload",
    value: string,
  ) => Promise<unknown>;
};

export async function emitTransaction(
  client: RedisStreamClient,
  event: TransactionEvent,
  stream = "stream:transactions",
  maxLength = DEFAULT_STREAM_MAXLEN,
): Promise<void> {
  const payload = transactionEventSchema.parse(event);
  await client.xadd(stream, "MAXLEN", "~", maxLength, "*", "payload", JSON.stringify(payload));
}
