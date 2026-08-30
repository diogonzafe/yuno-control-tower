// GENERATOR_INJECT_URL points at the generator's injection API when it runs on
// another host (Railway); falls back to the co-located generator for `pnpm dev`.
const INJECT_BASE =
  process.env.GENERATOR_INJECT_URL ??
  `http://127.0.0.1:${process.env.GENERATOR_INJECT_PORT ?? 4100}`;

// The generator requires this bearer token once its API is exposed off loopback.
function injectHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.INJECT_API_TOKEN) headers.Authorization = `Bearer ${process.env.INJECT_API_TOKEN}`;
  return headers;
}

export async function GET() {
  const response = await fetch(`${INJECT_BASE}/incidents`, { headers: injectHeaders() });
  const body = await response.text();
  return new Response(body, { status: response.status, headers: { "Content-Type": "application/json" } });
}

export async function POST(request: Request) {
  const body = await request.text();
  const response = await fetch(`${INJECT_BASE}/incidents`, { method: "POST", headers: injectHeaders(), body });
  const text = await response.text();
  return new Response(text, { status: response.status, headers: { "Content-Type": "application/json" } });
}
