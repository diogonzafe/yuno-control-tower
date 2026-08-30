import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env before importing anything that reaches db/client.ts: a static
// top-level import would be hoisted by ESM and evaluated before this config()
// call, and db/client.ts reads DATABASE_URL at module-load time. The dynamic
// imports below defer that evaluation until after the environment is loaded.
config({ path: resolve(import.meta.dirname, "../../../.env") });

const [{ default: pino }, { startConsumer }, queries, { startScheduler }, { createSignalStore }, { createSseHub }, { buildServer }] =
  await Promise.all([
    import("pino"),
    import("./ingest/consumer.js"),
    import("./db/queries.js"),
    import("./detect/scheduler.js"),
    import("./api/signal-store.js"),
    import("./api/sse.js"),
    import("./api/server.js"),
  ]);

const logger = pino({ name: "app" });
const port = Number(process.env.APP_PORT ?? 4000);

const store = createSignalStore();
const hub = createSseHub();
let ingestUp = true;

// rules.md §6.2: the app process consumes the stream, runs the detector, and
// serves REST/SSE — one process, so a confirmed drop reaches SSE through a
// function call instead of another Redis channel.
startConsumer().catch((error: unknown) => {
  ingestUp = false;
  logger.fatal({ error }, "ingest consumer crashed");
  process.exit(1);
});

const scheduler = startScheduler({
  source: queries.createRollupSource(),
  loadMerchants: queries.loadMerchantConfigs,
  loadCoverage: queries.loadRoutingCoverage,
  onResult: ({ bucket, signals, evidenceGaps }) => {
    store.addSignals(signals);
    store.addGaps(evidenceGaps);
    for (const signal of signals) hub.broadcast("signal", signal);
    for (const gap of evidenceGaps) hub.broadcast("evidence-gap", gap);
    if (signals.length > 0 || evidenceGaps.length > 0) {
      logger.info({ bucket, signals: signals.length, evidenceGaps: evidenceGaps.length }, "detection tick produced output");
    }
  },
});

const app = buildServer({
  store, hub,
  source: queries.createRollupSource(),
  getSchedulerStatus: scheduler.getStatus,
  isIngestUp: () => ingestUp,
});

await app.listen({ port, host: "0.0.0.0" });
logger.info({ port }, "app started: ingest + detector + API");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    hub.stop();
    app.close()
      .catch((error: unknown) => logger.error({ error }, "error while shutting down"))
      .finally(() => process.exit(0));
  });
}
