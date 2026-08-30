import { timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { TransactionGenerator } from "./engine.ts";
import type { GeneratorIncident } from "./incident.ts";

export type InjectApiOptions = {
  // When set, every request must carry `Authorization: Bearer <token>`.
  // run.ts requires this whenever the API is exposed beyond loopback.
  token?: string;
};

const incidentDimensionsSchema = z.object({
  merchantId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  country: z.enum(["AR", "MX", "BR"]).optional(),
  paymentMethod: z.enum(["CARD", "PIX"]).optional(),
  issuerId: z.string().min(1).optional(),
}).strict().superRefine((dimensions, ctx) => {
  if (dimensions.paymentMethod === "PIX" && dimensions.country !== undefined && dimensions.country !== "BR") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["country"],
      message: "PIX is only valid when country is BR",
    });
  }

  if (dimensions.paymentMethod === "PIX" && dimensions.issuerId !== undefined && dimensions.issuerId !== "NA") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issuerId"],
      message: "PIX incidents must not carry an issuer other than NA",
    });
  }
});

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

export function buildInjectApi(
  generator: TransactionGenerator,
  options: InjectApiOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });

  const { token } = options;
  if (token) {
    const expected = Buffer.from(`Bearer ${token}`, "utf8");
    app.addHook("preHandler", async (request, reply) => {
      const provided = Buffer.from(request.headers.authorization ?? "", "utf8");
      // Length check first: timingSafeEqual throws on a length mismatch.
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        await reply.status(401).send({ error: "unauthorized" });
      }
    });
  }

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
