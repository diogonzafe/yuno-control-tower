import type { PaymentMethod } from "./mix.ts";

export type IncidentDimensions = Partial<{
  merchantId: string;
  providerId: string;
  country: "AR" | "MX" | "BR";
  paymentMethod: PaymentMethod;
  issuerId: string;
}>;

export type GeneratorIncident = {
  id: string;
  startsAt: string;
  endsAt?: string;
  dimensions: IncidentDimensions;
  conversionMultiplier: number;
  latencyMsIncrease?: number;
  declineWeights?: Readonly<Record<string, number>>;
};

export type IncidentContext = Required<IncidentDimensions> & { at: string };

export type IncidentEffects = {
  conversionMultiplier: number;
  latencyMsIncrease: number;
  declineWeights: Readonly<Record<string, number>>;
};

export function applyIncidents(
  incidents: readonly GeneratorIncident[],
  context: IncidentContext,
): IncidentEffects {
  const effects: IncidentEffects = {
    conversionMultiplier: 1,
    latencyMsIncrease: 0,
    declineWeights: {},
  };
  const at = Date.parse(context.at);

  if (Number.isNaN(at)) throw new Error("incident context must contain a valid timestamp");

  for (const incident of incidents) {
    if (!isActive(incident, at) || !matchesDimensions(incident.dimensions, context)) continue;

    if (incident.conversionMultiplier < 0 || incident.conversionMultiplier > 1) {
      throw new Error("conversionMultiplier must be between zero and one");
    }

    effects.conversionMultiplier *= incident.conversionMultiplier;
    effects.latencyMsIncrease += incident.latencyMsIncrease ?? 0;
    effects.declineWeights = { ...effects.declineWeights, ...incident.declineWeights };
  }

  return effects;
}

function isActive(incident: GeneratorIncident, at: number): boolean {
  const startsAt = Date.parse(incident.startsAt);
  const endsAt = incident.endsAt === undefined ? undefined : Date.parse(incident.endsAt);
  if (Number.isNaN(startsAt) || (endsAt !== undefined && Number.isNaN(endsAt))) {
    throw new Error("incident timestamps must be valid ISO timestamps");
  }

  return startsAt <= at && (endsAt === undefined || at < endsAt);
}

function matchesDimensions(
  dimensions: IncidentDimensions,
  context: IncidentContext,
): boolean {
  return Object.entries(dimensions).every(([dimension, value]) =>
    context[dimension as keyof IncidentDimensions] === value,
  );
}
