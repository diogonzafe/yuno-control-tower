import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { RollupSource } from "../db/queries.js";
import { aggregateByBucket } from "../detect/aggregate.js";
import type { SchedulerStatus } from "../detect/scheduler.js";
import type { SliceFilter } from "../detect/types.js";
import type { SignalStore } from "./signal-store.js";
import type { SseConnection, SseHub } from "./sse.js";

export type ServerDeps = {
  store: SignalStore;
  hub: SseHub;
  source: RollupSource;
  getSchedulerStatus: () => SchedulerStatus;
  isIngestUp: () => boolean;
};

const limitQuery = z.object({ limit: z.coerce.number().int().positive().optional() });

const conversionQuery = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  merchantId: z.string().optional(),
  providerId: z.string().optional(),
  country: z.enum(["BR", "MX", "AR"]).optional(),
  paymentMethod: z.enum(["CARD", "PIX"]).optional(),
  issuerId: z.string().optional(),
});

export function buildServer(deps: ServerDeps): FastifyInstance {
  // `forceCloseConnections: true` (rather than the default 'idle') is what
  // makes `app.close()` actually resolve while an SSE client is connected:
  // an open EventSource is never "idle", and the 'idle' default only force-
  // closes through a branch gated on `serverFactory`, which this server
  // does not use.
  const app = Fastify({ logger: false, forceCloseConnections: true });

  // Pre-approved by rules.md §6.5. Both `fetch` and `EventSource` from a Vite
  // dev server on a different port are blocked outright without this.
  void app.register(cors, { origin: true });

  app.get("/health", async () => {
    const status = deps.getSchedulerStatus();
    return {
      status: status.lastError === null ? "ok" : "degraded",
      ingest: deps.isIngestUp() ? "up" : "down",
      lastTickAt: status.lastTickAt,
      lastProcessedBucket: status.lastProcessedBucket,
      bucketLagMinutes: status.bucketLagMinutes,
      lastError: status.lastError,
      sseConnections: deps.hub.connectionCount(),
    };
  });

  app.get("/api/signals", async (request, reply) => {
    const query = limitQuery.safeParse(request.query);
    if (!query.success) {
      await reply.status(400).send({ error: "invalid query", issues: query.error.issues });
      return;
    }
    return deps.store.recentSignals(query.data.limit);
  });

  app.get("/api/evidence-gaps", async (request, reply) => {
    const query = limitQuery.safeParse(request.query);
    if (!query.success) {
      await reply.status(400).send({ error: "invalid query", issues: query.error.issues });
      return;
    }
    return deps.store.recentGaps(query.data.limit);
  });

  app.get("/api/conversion", async (request, reply) => {
    const query = conversionQuery.safeParse(request.query);
    if (!query.success) {
      await reply.status(400).send({ error: "invalid query", issues: query.error.issues });
      return;
    }

    const { from, to, ...dimensions } = query.data;
    const filter: SliceFilter = Object.fromEntries(
      Object.entries(dimensions).filter(([, value]) => value !== undefined),
    );
    const rows = await deps.source.getHistory(from, to);

    // Reuses the detector's own aggregation rather than adding a second
    // implementation of approved/attempts (rules.md §1, DRY).
    return aggregateByBucket(rows, { filter }).map((point) => ({
      bucket: point.bucket,
      attempts: point.attempts,
      approved: point.approved,
      rate: point.rate,
    }));
  });

  app.get("/api/stream", (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    deps.hub.register(reply.raw as unknown as SseConnection);
  });

  return app;
}
