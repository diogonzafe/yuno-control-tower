import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env before importing anything that reaches db/client.ts: a static
// top-level import would be hoisted by ESM and evaluated before this config()
// call, and db/client.ts reads DATABASE_URL at module-load time. The dynamic
// imports below defer that evaluation until after the environment is loaded.
config({ path: resolve(import.meta.dirname, "../../../.env") });

const [
  { default: pino },
  { startConsumer },
  queries,
  { startScheduler },
  { createSignalStore },
  { createEvidenceStore },
  { createSseHub },
  { buildServer },
] = await Promise.all([
  import("pino"),
  import("./ingest/consumer.js"),
  import("./db/queries.js"),
  import("./detect/scheduler.js"),
  import("./api/signal-store.js"),
  import("./api/evidence-store.js"),
  import("./api/sse.js"),
  import("./api/server.js"),
]);

const logger = pino({ name: "app" });
const port = Number(process.env.APP_PORT ?? 4000);

const store = createSignalStore();
const evidenceStore = createEvidenceStore();
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
  declineSource: queries.createDeclineSource(),
  loadMerchants: queries.loadMerchantConfigs,
  loadCoverage: queries.loadRoutingCoverage,
  loadDeclineCatalog: queries.loadDeclineCatalog,
  onResult: ({ bucket, signals, evidenceGaps, evidence }) => {
    store.addSignals(signals);
    store.addGaps(evidenceGaps);
    evidenceStore.add(evidence);
    for (const signal of signals) hub.broadcast("signal", signal);
    for (const gap of evidenceGaps) hub.broadcast("evidence-gap", gap);
    for (const item of evidence) hub.broadcast("evidence", item);
    if (signals.length > 0 || evidenceGaps.length > 0) {
      logger.info(
        { bucket, signals: signals.length, evidenceGaps: evidenceGaps.length, evidence: evidence.length },
        "detection tick produced output",
      );
    }
  },
});

const app = buildServer({
  store, evidenceStore, hub,
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
    // Insurance: even if app.close() somehow still hangs (a socket hub.stop()
    // didn't reach, some other stuck handle), the process must not survive
    // Ctrl+C forever mid-demo.
    setTimeout(() => process.exit(0), 5_000).unref();
    app.close()
      .catch((error: unknown) => logger.error({ error }, "error while shutting down"))
      .finally(() => process.exit(0));
  });
}
