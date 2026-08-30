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
  agent,
  { createSignalStore },
  { createEvidenceStore },
  { createSseHub },
  { buildServer },
  orchestrate,
] = await Promise.all([
  import("pino"),
  import("./ingest/consumer.js"),
  import("./db/queries.js"),
  import("./detect/scheduler.js"),
  import("./agent/index.js"),
  import("./api/signal-store.js"),
  import("./api/evidence-store.js"),
  import("./api/sse.js"),
  import("./api/server.js"),
  import("./orchestrate/index.js"),
]);

// A causal cell refines the root that triggered it: it fixes every dimension
// the root fixes, and may fix more (DD17 root is merchant×country, DD19 caps
// depth at 3). `buildEvidence` keeps only `diagnosis.cell`, so containment is
// how an EvidenceObject finds the ConfirmedDrop it came from.
function refines(
  cell: Record<string, string | undefined>,
  root: Record<string, string | undefined>,
): boolean {
  return Object.entries(root)
    .filter(([, value]) => value !== undefined)
    .every(([key, value]) => cell[key] === value);
}

const logger = pino({ name: "app" });
const port = Number(process.env.APP_PORT ?? 4000);

const store = createSignalStore();
const evidenceStore = createEvidenceStore();
const hub = createSseHub();
const incidentWriter = orchestrate.createIncidentWriter();
const lifecycle = orchestrate.createLifecycle();
const repository = new agent.PostgresInvestigationRunRepository(undefined, {
  onRun: (run) => hub.broadcast("investigation-run", run),
  onStep: (step) => hub.broadcast("investigation-step", step),
});
const coordinator = agent.createAgentCoordinator({
  source: queries.createRollupSource(),
  declineSource: queries.createDeclineSource(),
  loadMerchants: queries.loadMerchantConfigs,
  loadCoverage: queries.loadRoutingCoverage,
  loadDeclineCatalog: queries.loadDeclineCatalog,
  repository,
  incidentWriter,
  config: agent.loadAgentConfig(),
  onEvidence: (evidence: import("@control-tower/contracts").EvidenceObject) => {
    evidenceStore.add([evidence]);
    hub.broadcast("evidence", evidence);
  },
  onNarrative: (payload: { incidentId: string; narrative: import("@control-tower/contracts").NarrativeOutput }) =>
    hub.broadcast("narrative", payload),
});
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
  // Kept on so the beam-search path runs on every tick and reaches the API on
  // its own. roadmap.md §7 puts the agentic layer first on the cut list, and
  // turning this off would make agent/ load-bearing — deleting it would delete
  // the evidence pipeline with it. The coordinator's richer evidence replaces
  // this one by fingerprint in the store (api/evidence-store.ts).
  emitDeterministicEvidence: true,
  onResult: ({ bucket, signals, evidenceGaps, evidence }) => {
    store.addSignals(signals);
    store.addGaps(evidenceGaps);
    evidenceStore.add(evidence);

    void (async () => {
      // Order matters: openOrUpdate bumps detected_at for every cell still
      // down, so a cell reconfirmed in THIS bucket is never resolved by the
      // reconcile pass that follows it.
      const opened = new Map<string, string>();
      for (const item of evidence) {
        const upserted = await incidentWriter.openOrUpdate(item);
        opened.set(item.fingerprint, upserted.incidentId);
      }

      const transitions = await lifecycle.reconcile({ bucket, evidenceGaps });
      if (transitions.resolve.length > 0 || transitions.inconclusive.length > 0) {
        hub.broadcast("incident-transitions", { bucket, ...transitions });
        logger.info({ bucket, ...transitions }, "incident lifecycle reconciled");
      }

      for (const item of evidence) hub.broadcast("evidence", item);
      for (const signal of signals) hub.broadcast("signal", signal);
      for (const gap of evidenceGaps) hub.broadcast("evidence-gap", gap);

      for (const item of evidence) {
        const incidentId = opened.get(item.fingerprint);
        if (!incidentId) continue;
        // The causal cell always fixes every dimension the root fixes, plus up
        // to three more (DD19), so the trigger is the signal the evidence
        // refines. Peeling can put two evidence objects under one signal —
        // that is criterion 5, and each gets its own investigation.
        const trigger = signals.find((signal) => refines(item.dimensions, signal.dimensions));
        if (!trigger) continue;
        void coordinator
          .handleSignal({ signal: trigger, incidentId, fingerprint: item.fingerprint })
          .catch((error: unknown) => {
            logger.error({ error, bucket, incidentId }, "agent coordinator failed");
          });
      }

      if (signals.length > 0 || evidenceGaps.length > 0) {
        logger.info(
          { bucket, signals: signals.length, evidenceGaps: evidenceGaps.length, evidence: evidence.length },
          "detection tick produced output",
        );
      }
    })().catch((error: unknown) => {
      // A failed write must not kill the tick: openOrUpdate is idempotent by
      // fingerprint and reconcile derives everything from detected_at, so the
      // next bucket recovers on its own.
      logger.error({ error, bucket }, "orchestration failed for this tick");
    });
  },
});

const app = buildServer({
  store, evidenceStore, hub,
  repository,
  source: queries.createRollupSource(),
  getSchedulerStatus: scheduler.getStatus,
  isIngestUp: () => ingestUp,
});

await coordinator.recoverOrphanRuns();
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
