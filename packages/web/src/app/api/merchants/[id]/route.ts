import { z } from "zod";
import { updateMerchantExpectedConversion } from "@control-tower/app";

export const dynamic = "force-dynamic";

const patchBody = z.object({ expectedConversion: z.number().min(0).max(1) });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = patchBody.safeParse(await request.json());
  if (!result.success) {
    return Response.json({ error: "invalid body", issues: result.error.issues }, { status: 400 });
  }

  const updated = await updateMerchantExpectedConversion(id, result.data.expectedConversion);
  if (!updated) {
    return Response.json({ error: "merchant not found" }, { status: 404 });
  }
  return Response.json(updated);
}
