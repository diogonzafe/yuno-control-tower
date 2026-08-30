import { getIncidents, getPortfolioSeries, getProviderSeries } from "@control-tower/app";

export const dynamic = "force-dynamic";
// A serverless platform caps a streaming response at the function timeout
// (~10s default on Vercel). The client (use-control-tower-stream.ts) reconnects
// on drop, so the worst case degrades to a reconnect every maxDuration.
export const maxDuration = 60;

const LOOKBACK_MS = 60 * 60_000;

async function snapshot() {
  const sinceBucket = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const [incidents, providerSeries, portfolioSeries] = await Promise.all([
    getIncidents(100),
    getProviderSeries(sinceBucket),
    getPortfolioSeries(sinceBucket),
  ]);
  return { incidents, providerSeries, portfolioSeries, generatedAt: new Date().toISOString() };
}

export async function GET() {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = async () => {
        try {
          const data = await snapshot();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
        }
      };
      await send();
      interval = setInterval(send, 4000);
    },
    cancel() {
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
