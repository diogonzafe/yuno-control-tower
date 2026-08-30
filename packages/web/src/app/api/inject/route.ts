const INJECT_BASE = `http://127.0.0.1:${process.env.GENERATOR_INJECT_PORT ?? 4100}`;

export async function GET() {
  const response = await fetch(`${INJECT_BASE}/incidents`);
  const body = await response.text();
  return new Response(body, { status: response.status, headers: { "Content-Type": "application/json" } });
}

export async function POST(request: Request) {
  const body = await request.text();
  const response = await fetch(`${INJECT_BASE}/incidents`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const text = await response.text();
  return new Response(text, { status: response.status, headers: { "Content-Type": "application/json" } });
}
