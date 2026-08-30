// GENERATOR_INJECT_URL points at the generator's injection API when it runs on
// another host (Railway); falls back to the co-located generator for `pnpm dev`.
const INJECT_BASE =
  process.env.GENERATOR_INJECT_URL ??
  `http://127.0.0.1:${process.env.GENERATOR_INJECT_PORT ?? 4100}`;

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // The generator requires this bearer token once its API is exposed off loopback.
  const headers: Record<string, string> = {};
  if (process.env.INJECT_API_TOKEN) headers.Authorization = `Bearer ${process.env.INJECT_API_TOKEN}`;
  const response = await fetch(`${INJECT_BASE}/incidents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers,
  });
  return new Response(null, { status: response.status });
}
