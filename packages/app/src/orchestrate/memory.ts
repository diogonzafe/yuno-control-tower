import { and, desc, eq, ne } from "drizzle-orm";
import { SimilarIncident, type RootCauseDimension } from "@control-tower/contracts";
import { db as defaultDatabase } from "../db/client.js";
import { incidents } from "../db/schema.js";

type Database = typeof defaultDatabase;

const DEFAULT_LIMIT = 3;

// Mirrors the four playbook YAML files, deliberately duplicated rather than
// imported from agent/playbooks.ts: roadmap.md §7 lists the agentic layer as
// cut #4, and orchestrate/ has to keep working after that cut.
const PLAYBOOK_ROOT_CAUSE: Record<string, RootCauseDimension> = {
  "provider-default": "provider",
  "issuer-default": "issuer",
  "method-country-default": "payment_method",
  "merchant-default": "merchant",
};

export type IncidentMemory = {
  recallByFingerprint(input: {
    fingerprint: string;
    excludeIncidentId?: string;
    limit?: number;
  }): Promise<SimilarIncident[]>;
};

export function createIncidentMemory(database: Database = defaultDatabase): IncidentMemory {
  return {
    async recallByFingerprint(input) {
      const filters = [
        eq(incidents.fingerprint, input.fingerprint),
        eq(incidents.status, "resolved"),
      ];
      if (input.excludeIncidentId) {
        filters.push(ne(incidents.incidentId, input.excludeIncidentId));
      }

      // Single indexed lookup on ix_incident_fingerprint. DD15: exact
      // fingerprint is the only recognition path; pgvector is deferred.
      const rows = await database
        .select({
          incidentId: incidents.incidentId,
          fingerprint: incidents.fingerprint,
          dominantDecline: incidents.dominantDecline,
          playbookId: incidents.playbookId,
          startedAt: incidents.startedAt,
          resolvedAt: incidents.resolvedAt,
          costUsdMinor: incidents.costUsdMinor,
        })
        .from(incidents)
        .where(and(...filters))
        .orderBy(desc(incidents.detectedAt))
        .limit(input.limit ?? DEFAULT_LIMIT);

      return rows.map((row) =>
        SimilarIncident.parse({
          incidentId: row.incidentId,
          fingerprint: row.fingerprint,
          rootCauseDimension: row.playbookId ? PLAYBOOK_ROOT_CAUSE[row.playbookId] ?? null : null,
          dominantDecline: row.dominantDecline,
          // Built from columns only. This string reaches the investigator's
          // prompt, and model-written text re-entering as evidence would
          // launder invention into fact.
          summary:
            `Same cell was down from ${row.startedAt.toISOString()} ` +
            `until ${row.resolvedAt?.toISOString() ?? "unknown"}, ` +
            `dominant decline ${row.dominantDecline ?? "none"}, ` +
            `cost ${row.costUsdMinor} USD minor units.`,
        }),
      );
    },
  };
}
