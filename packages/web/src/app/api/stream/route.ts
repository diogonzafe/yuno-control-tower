import type { PendingSignal } from "@control-tower/contracts";
import { getIncidents, getPortfolioSeries, getProviderSeries } from "@control-tower/app";

export const dynamic = "force-dynamic";

// The scheduler's in-flight persistence state lives only inside the "app"
// process's memory (detect/scheduler.ts) — nothing to query in Postgres for
// it — so this is the one piece of the snapshot that crosses services
// instead of hitting the database directly like the rest of this route.
const APP_API_URL = process.env.APP_API_URL ?? "http://127.0.0.1:4000";

async function getPendingSignals(): Promise<PendingSignal[]> {
  try {
    const response = await fetch(`${APP_API_URL}/api/pending-signals`, { cache: "no-store" });
    if (!response.ok) return [];
    return (await response.json()) as PendingSignal[];
  } catch {
    // The dashboard's own DB-backed data must not go dark just because the
    // cross-service call to "app" failed — pending signals are a nice-to-have.
    return [];
  }
}
// A serverless platform caps a streaming response at the function timeout
// (~10s default on Vercel). The client (use-control-tower-stream.ts) reconnects
// on drop, so the worst case degrades to a reconnect every maxDuration.
export const maxDuration = 60;

const LOOKBACK_MS = 60 * 60_000;
const TICK_MS = 4000;
// Close a few seconds before the platform kills the function so teardown is
// graceful and the client reconnects on its own terms.
const SELF_CLOSE_MS = (maxDuration - 5) * 1000;

async function snapshot() {
  const sinceBucket = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const [incidents, providerSeries, portfolioSeries, pendingSignals] = await Promise.all([
    getIncidents(100),
    getProviderSeries(sinceBucket),
    getPortfolioSeries(sinceBucket),
    getPendingSignals(),
  ]);
  return { incidents, providerSeries, portfolioSeries, pendingSignals, generatedAt: new Date().toISOString() };
}

export function GET(request: Request) {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let selfClose: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Idempotent teardown: stop the timers and best-effort close the stream.
      // Called on client disconnect (request abort), on the self-close timer,
      // on stream cancel, and on the first failed enqueue.
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (interval) clearInterval(interval);
        if (selfClose) clearTimeout(selfClose);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime — nothing to do.
        }
      };

      const send = async () => {
        if (stopped) return;
        let frame: string;
        try {
          const data = await snapshot();
          frame = `data: ${JSON.stringify(data)}\n\n`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          frame = `event: error\ndata: ${JSON.stringify({ message })}\n\n`;
        }
        // The await above yields — the connection may have gone away while we
        // were querying. Re-check, then guard the enqueue itself.
        if (stopped) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Controller is already closed (client vanished, function timed out).
          // Stop cleanly instead of throwing an unhandled rejection out of the
          // interval callback.
          stop();
        }
      };

      request.signal.addEventListener("abort", stop);

      await send();
      if (stopped) return;
      interval = setInterval(send, TICK_MS);
      selfClose = setTimeout(stop, SELF_CLOSE_MS);
    },
    cancel() {
      stopped = true;
      if (interval) clearInterval(interval);
      if (selfClose) clearTimeout(selfClose);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
