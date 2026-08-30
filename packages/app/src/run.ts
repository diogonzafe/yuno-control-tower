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

// An EvidenceObject carries only `diagnosis.cell`, so it has to find the
// ConfirmedDrop it came from by dimensions. Containment does not work: the two
// sit on different branches of the split. crossSectionalSweep (detect/trigger.ts)
// emits signals at provider, paymentMethod and issuer cells, while the beam
// search never adds paymentMethod to an issuer cell — so an issuer incident has
// signal {merchantId, country, paymentMethod: "CARD", issuerId} against evidence
// {merchantId, country, issuerId}, and any full-dimension test drops it.
// merchantId×country is the only reliable join, because it is exactly what
// diagnose/run.ts's rootsOf collapses signals to before running the search that
// produced this evidence. Several signals can share one root; any of them is a
// valid trigger, since by construction they agree on it.
function sharesRoot(
  cell: Record<string, string | undefined>,
  signal: Record<string, string | undefined>,
): boolean {
  if (cell.merchantId === undefined || cell.country === undefined) return false;
  return cell.merchantId === signal.merchantId && cell.country === signal.country;
}

const logger = pino({ name: "app" });
const port = Number(process.env.APP_PORT ?? 4000);

// onResult is synchronous and the scheduler's catch-up loop calls it once per
// bucket without awaiting what the callback starts, so unserialized ticks would
// interleave their writes: bucket N+1's reconcile could run before bucket N's
// openOrUpdate bumped detected_at and resolve a cell that was just reconfirmed,
// and two openOrUpdate calls for one fingerprint could both miss the SELECT and
// both INSERT — incidents.fingerprint carries an index, not a unique
// constraint, so that yields two live ids for one cell and two investigations.
let orchestrationTail: Promise<void> = Promise.resolve();

function enqueueOrchestration(bucket: string, work: () => Promise<void>): void {
  // The .catch is applied to the stored tail, not to a copy: the tail must stay
  // fulfilled so one failed bucket cannot poison every bucket behind it.
  // openOrUpdate is idempotent by fingerprint and reconcile derives everything
  // from detected_at, so the next bucket recovers on its own.
  orchestrationTail = orchestrationTail.then(work).catch((error: unknown) => {
    logger.error({ error, bucket }, "orchestration failed for this tick");
  });
}

const store = createSignalStore();
const evidenceStore = createEvidenceStore();
const hub = createSseHub();
const incidentWriter = orchestrate.createIncidentWriter();
const lifecycle = orchestrate.createLifecycle();
const incidentMemory = orchestrate.createIncidentMemory();
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
  memory: incidentMemory,
  config: agent.loadAgentConfig(),
  onEvidence: (evidence: import("@control-tower/contracts").EvidenceObject) => {
    evidenceStore.add([evidence]);
    hub.broadcast("evidence", evidence);
  },
  onNarrative: (payload: { incidentId: string; narrative: import("@control-tower/contracts").NarrativeOutput }) =>
    hub.broadcast("narrative", payload),
  onMemoryError: (error: unknown) => logger.warn({ error }, "incident memory recall failed"),
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

    // Broadcast before any await, exactly as this callback did before incidents
    // were wired in. None of these payloads carries an incidentId, so nothing is
    // gained by waiting — and a database hiccup, or a queued bucket ahead of
    // this one, must not cost the UI a whole tick of signals and gaps.
    for (const item of evidence) hub.broadcast("evidence", item);
    for (const signal of signals) hub.broadcast("signal", signal);
    for (const gap of evidenceGaps) hub.broadcast("evidence-gap", gap);

    if (signals.length > 0 || evidenceGaps.length > 0) {
      logger.info(
        { bucket, signals: signals.length, evidenceGaps: evidenceGaps.length, evidence: evidence.length },
        "detection tick produced output",
      );
    }

    enqueueOrchestration(bucket, async () => {
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

      for (const item of evidence) {
        const incidentId = opened.get(item.fingerprint);
        if (!incidentId) continue;
        // Peeling can put two evidence objects under one signal — that is
        // spec.md §4 criterion 5, and each gets its own incident and its own
        // investigation off the same trigger.
        const trigger = signals.find((signal) => sharesRoot(item.dimensions, signal.dimensions));
        if (!trigger) continue;
        void coordinator
          .handleSignal({ signal: trigger, incidentId, fingerprint: item.fingerprint })
          .catch((error: unknown) => {
            logger.error({ error, bucket, incidentId }, "agent coordinator failed");
          });
      }
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
