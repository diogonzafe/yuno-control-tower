import { z } from "zod";
import { listMerchantSettings, updateAllMerchantsExpectedConversion } from "@control-tower/app";

export const dynamic = "force-dynamic";

const patchBody = z.object({ expectedConversion: z.number().min(0).max(1) });

export async function GET() {
  const settings = await listMerchantSettings();
  return Response.json(settings);
}

export async function PATCH(request: Request) {
  const result = patchBody.safeParse(await request.json());
  if (!result.success) {
    return Response.json({ error: "invalid body", issues: result.error.issues }, { status: 400 });
  }

  const updated = await updateAllMerchantsExpectedConversion(result.data.expectedConversion);
  return Response.json(updated);
}
