import { getCatalog } from "@control-tower/app";

export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await getCatalog();
  return Response.json(catalog);
}
