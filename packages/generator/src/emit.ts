import { transactionEventSchema, type TransactionEvent } from "@control-tower/contracts";

export type RedisStreamClient = {
  xadd: (stream: string, id: "*", field: "payload", value: string) => Promise<unknown>;
};

export async function emitTransaction(
  client: RedisStreamClient,
  event: TransactionEvent,
  stream = "stream:transactions",
): Promise<void> {
  const payload = transactionEventSchema.parse(event);
  await client.xadd(stream, "*", "payload", JSON.stringify(payload));
}
