import Redis from "ioredis";
import pino from "pino";
import { transactionEventSchema, type TransactionEvent } from "@control-tower/contracts";
import { processBatch } from "./rollup";

const logger = pino({ name: "ingest-consumer" });

const STREAM_KEY = "stream:transactions";
const GROUP_NAME = "ingest";
const CONSUMER_NAME = "app-1";
const BATCH_SIZE = 100;
const BLOCK_MS = 500;
const MAX_DB_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 200;

type RawStreamEntry = [id: string, fields: string[]];
type RawReadGroupReply = [streamKey: string, entries: RawStreamEntry[]][] | null;
type RawAutoClaimReply = [cursor: string, entries: RawStreamEntry[], deletedIds: string[]];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  } catch (error) {
    const isBusyGroup = error instanceof Error && error.message.includes("BUSYGROUP");
    if (!isBusyGroup) {
      throw error;
    }
  }
}

function parseEntries(rawEntries: RawStreamEntry[]): {
  valid: { id: string; event: TransactionEvent }[];
  invalidIds: string[];
} {
  const valid: { id: string; event: TransactionEvent }[] = [];
  const invalidIds: string[] = [];

  for (const [id, fields] of rawEntries) {
    const payloadIndex = fields.indexOf("payload");
    const rawPayload = payloadIndex >= 0 ? fields[payloadIndex + 1] : undefined;

    if (!rawPayload) {
      logger.error({ id }, "stream entry is missing the payload field");
      invalidIds.push(id);
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawPayload);
    } catch (error) {
      logger.error({ id, rawPayload, error }, "payload is not valid JSON");
      invalidIds.push(id);
      continue;
    }

    const result = transactionEventSchema.safeParse(parsedJson);
    if (!result.success) {
      logger.error(
        { id, rawPayload, issues: result.error.issues },
        "payload failed schema validation",
      );
      invalidIds.push(id);
      continue;
    }

    valid.push({ id, event: result.data });
  }

  return { valid, invalidIds };
}

async function processBatchWithRetry(events: TransactionEvent[]): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await processBatch(events);
      return;
    } catch (error) {
      attempt += 1;
      logger.error({ attempt, error }, "batch processing failed");
      if (attempt >= MAX_DB_RETRIES) {
        logger.fatal({ error }, "giving up after max retries, exiting process");
        process.exit(1);
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

async function handleEntries(redis: Redis, rawEntries: RawStreamEntry[]): Promise<void> {
  if (rawEntries.length === 0) {
    return;
  }

  const { valid, invalidIds } = parseEntries(rawEntries);

  if (valid.length > 0) {
    await processBatchWithRetry(valid.map((entry) => entry.event));
  }

  const allIds = [...valid.map((entry) => entry.id), ...invalidIds];
  if (allIds.length > 0) {
    await redis.xack(STREAM_KEY, GROUP_NAME, ...allIds);
  }
}

async function reclaimPending(redis: Redis): Promise<void> {
  const reply = (await redis.call(
    "XAUTOCLAIM",
    STREAM_KEY,
    GROUP_NAME,
    CONSUMER_NAME,
    "0",
    "0",
  )) as RawAutoClaimReply;

  const [, entries] = reply;
  await handleEntries(redis, entries);
}

export async function startConsumer(): Promise<never> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not set — check .env");
  }

  const redis = new Redis(redisUrl);

  await ensureConsumerGroup(redis);
  await reclaimPending(redis);
  logger.info({ stream: STREAM_KEY, group: GROUP_NAME }, "ingest consumer started");

  for (;;) {
    const reply = (await redis.call(
      "XREADGROUP",
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      BATCH_SIZE,
      "BLOCK",
      BLOCK_MS,
      "STREAMS",
      STREAM_KEY,
      ">",
    )) as RawReadGroupReply;

    if (!reply) {
      continue;
    }

    const [, entries] = reply[0]!;
    await handleEntries(redis, entries);
  }
}
