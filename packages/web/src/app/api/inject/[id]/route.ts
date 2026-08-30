const INJECT_BASE = `http://127.0.0.1:${process.env.GENERATOR_INJECT_PORT ?? 4100}`;

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const response = await fetch(`${INJECT_BASE}/incidents/${encodeURIComponent(id)}`, { method: "DELETE" });
  return new Response(null, { status: response.status });
}
