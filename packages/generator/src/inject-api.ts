import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { TransactionGenerator } from "./engine.ts";
import type { GeneratorIncident } from "./incident.ts";

const incidentDimensionsSchema = z.object({
  merchantId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  country: z.enum(["AR", "MX", "BR"]).optional(),
  paymentMethod: z.enum(["CARD", "PIX"]).optional(),
  issuerId: z.string().min(1).optional(),
}).strict();

// Mirrors GeneratorIncident (incident.ts) exactly — this is the jury's
// injection console contract, so a malformed request must fail loudly with
// a 400 rather than reach the in-memory engine in a half-valid shape.
const incidentSchema = z.object({
  id: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  dimensions: incidentDimensionsSchema,
  conversionMultiplier: z.number().min(0).max(1),
  latencyMsIncrease: z.number().nonnegative().optional(),
  declineWeights: z.record(z.string(), z.number().nonnegative()).optional(),
});

export function buildInjectApi(generator: TransactionGenerator): FastifyInstance {
  const app = Fastify({ logger: false });

  app.post("/incidents", async (request, reply) => {
    const result = incidentSchema.safeParse(request.body);
    if (!result.success) {
      await reply.status(400).send({ error: "invalid incident payload", issues: result.error.issues });
      return;
    }

    const incident: GeneratorIncident = result.data;
    generator.addIncident(incident);
    await reply.status(201).send(incident);
  });

  app.delete<{ Params: { id: string } }>("/incidents/:id", async (request, reply) => {
    const removed = generator.removeIncident(request.params.id);
    await reply.status(removed ? 204 : 404).send();
  });

  app.get("/incidents", async () => generator.activeIncidents());

  return app;
}
