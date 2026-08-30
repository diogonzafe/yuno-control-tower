import { config } from "dotenv";
import Redis from "ioredis";
import pino from "pino";
import { resolve } from "node:path";

import { pickAutoIncidents } from "./auto-incidents.ts";
import { buildGeneratorCatalog, type MerchantTrafficWeights } from "./catalog.ts";
import { emitTransaction } from "./emit.ts";
import { createGenerator, startGenerator } from "./engine.ts";
import { buildInjectApi } from "./inject-api.ts";
import { createSeededRandom } from "./random.ts";

config({ path: resolve(import.meta.dirname, "../../../.env") });

const logger = pino({ name: "generator" });

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set — check .env");
}

const injectPort = Number(process.env.GENERATOR_INJECT_PORT ?? 4100);
// The ingest consumer drains ~41 events/s against cloud Redis + cloud Postgres.
// transactionsPerSecond multiplies this by a seasonal factor that peaks at
// ~1.74x, so a baseTps above ~23 outruns the consumer at peak hour and builds an
// unbounded stream backlog — which starves the detector of current buckets.
const baseTps = parsePositiveNumber(process.env.GENERATOR_BASE_TPS);
const trafficWeights = parseTrafficWeights(process.env.GENERATOR_TRAFFIC_WEIGHTS);
const defaultConversion = parseOptionalNumber(process.env.GENERATOR_DEFAULT_CONVERSION);
const randomizeConversion = parseBooleanFlag(process.env.GENERATOR_RANDOMIZE_CONVERSION);
const autoIncidentCount = parseOptionalInteger(process.env.GENERATOR_AUTO_INCIDENTS) ?? 0;
const randomizeIncidents = parseBooleanFlag(process.env.GENERATOR_RANDOMIZE_INCIDENTS);

// A single shared random source: reproducible by default (fixed seed), or a
// fresh Date.now()-seeded one per run when either randomize flag is set, so
// the jury sees a different mix on every restart instead of the same replay.
const random = createSeededRandom(randomizeConversion || randomizeIncidents ? Date.now() : 42);

const catalog = buildGeneratorCatalog({ defaultConversion, randomizeConversion, random });

const redis = new Redis(redisUrl);
const generator = createGenerator({ catalog, trafficWeights, random });
const runtime = startGenerator(generator, (event) => emitTransaction(redis, event), { baseTps });

for (const incident of pickAutoIncidents(catalog, autoIncidentCount, random, new Date())) {
  generator.addIncident(incident);
}

const injectApi = buildInjectApi(generator);
await injectApi.listen({ port: injectPort, host: "127.0.0.1" });

logger.info(
  {
    stream: "stream:transactions",
    baseTps: baseTps ?? "default (60)",
    injectPort,
    defaultConversion: defaultConversion ?? "default (0.90)",
    randomizeConversion,
    autoIncidentCount,
    randomizeIncidents,
  },
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

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`expected a finite number, got: ${value}`);
  }
  return parsed;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  const parsed = parseOptionalNumber(value);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative integer, got: ${value}`);
  }
  return parsed;
}

// startGenerator only reads baseTps inside the tick, so an invalid value would
// otherwise surface as a throw from a timer callback rather than at boot.
function parsePositiveNumber(value: string | undefined): number | undefined {
  const parsed = parseOptionalNumber(value);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) {
    throw new Error(`expected a positive number, got: ${value}`);
  }
  return parsed;
}

function parseBooleanFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
