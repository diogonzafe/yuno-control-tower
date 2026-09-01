import { listMerchantSettings } from "@control-tower/app";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await listMerchantSettings();
  return Response.json(settings);
}
