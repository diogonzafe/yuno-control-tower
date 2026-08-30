import { config } from "dotenv";
import Redis from "ioredis";
import pino from "pino";
import { resolve } from "node:path";

import { defaultGeneratorCatalog, type MerchantTrafficWeights } from "./catalog.ts";
import { emitTransaction } from "./emit.ts";
import { createGenerator, startGenerator } from "./engine.ts";
import { buildInjectApi } from "./inject-api.ts";

config({ path: resolve(import.meta.dirname, "../../../.env") });

const logger = pino({ name: "generator" });

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set — check .env");
}

const injectPort = Number(process.env.GENERATOR_INJECT_PORT ?? 4100);

const trafficWeights = parseTrafficWeights(process.env.GENERATOR_TRAFFIC_WEIGHTS);
const redis = new Redis(redisUrl);
const generator = createGenerator({
  catalog: defaultGeneratorCatalog,
  trafficWeights,
});
const runtime = startGenerator(generator, (event) => emitTransaction(redis, event));

const injectApi = buildInjectApi(generator);
await injectApi.listen({ port: injectPort, host: "127.0.0.1" });

logger.info(
  { stream: "stream:transactions", baseTps: 60, injectPort },
  "generator started",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    runtime.stop();
    Promise.all([injectApi.close(), redis.quit()])
      .catch((error: unknown) => logger.error({ error }, "error while shutting down"))
      .finally(() => process.exit(0));
  });
}

function parseTrafficWeights(value: string | undefined): MerchantTrafficWeights {
  if (!value) {
    throw new Error("GENERATOR_TRAFFIC_WEIGHTS is required while P1 remains open");
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed as MerchantTrafficWeights;
  } catch (error) {
    throw new Error(`GENERATOR_TRAFFIC_WEIGHTS must be valid JSON: ${String(error)}`);
  }
}
