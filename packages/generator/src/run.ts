import { config } from "dotenv";
import Redis from "ioredis";
import { resolve } from "node:path";

import { defaultGeneratorCatalog, type MerchantTrafficWeights } from "./catalog.ts";
import { emitTransaction } from "./emit.ts";
import { createGenerator, startGenerator } from "./engine.ts";

config({ path: resolve(import.meta.dirname, "../../../.env") });

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set — check .env");
}

const trafficWeights = parseTrafficWeights(process.env.GENERATOR_TRAFFIC_WEIGHTS);
const redis = new Redis(redisUrl);
const generator = createGenerator({
  catalog: defaultGeneratorCatalog,
  trafficWeights,
});
const runtime = startGenerator(generator, (event) => emitTransaction(redis, event));

console.info("generator started", { stream: "stream:transactions", baseTps: 60 });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    runtime.stop();
    void redis.quit().finally(() => process.exit(0));
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
