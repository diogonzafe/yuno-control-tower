import { and, inArray } from "drizzle-orm";
import type { EvidenceGap } from "@control-tower/contracts";
import { db as defaultDatabase } from "../db/client.js";
import { incidents } from "../db/schema.js";

type Database = typeof defaultDatabase;

// Symmetric to the detector's PERSISTENCE_WINDOWS = 3: it takes three windows
// to confirm a drop, so it takes three quiet windows to call it recovered.
// Deliberately not imported from detect/constants.ts — that constant belongs to
// the trigger, and coupling the two would be accidental rather than real.
export const RESOLVE_AFTER_QUIET_WINDOWS = 3;

const ACTIVE_STATUSES = ["open", "monitoring"] as const;

export type ActiveIncident = {
  incidentId: string;
  detectedAt: string;
  dimensions: Record<string, string | undefined>;
};

export type Transitions = {
  resolve: string[];
  inconclusive: string[];
};

export type Lifecycle = {
  reconcile(input: { bucket: string; evidenceGaps: EvidenceGap[] }): Promise<Transitions>;
};

function sameCell(
  left: Record<string, string | undefined>,
  right: Record<string, string | undefined>,
): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return keys.every((key) => left[key] === right[key]);
}

function quietWindows(bucket: string, detectedAt: string): number {
  return Math.round((new Date(bucket).getTime() - new Date(detectedAt).getTime()) / 60_000);
}

export function planTransitions(input: {
  bucket: string;
  active: ActiveIncident[];
  evidenceGaps: EvidenceGap[];
}): Transitions {
  const resolve: string[] = [];
  const inconclusive: string[] = [];

  for (const incident of input.active) {
    if (quietWindows(input.bucket, incident.detectedAt) < RESOLVE_AFTER_QUIET_WINDOWS) {
      continue;
    }
    const lostVolume = input.evidenceGaps.some((gap) =>
      sameCell(incident.dimensions, gap.dimensions as Record<string, string | undefined>),
    );
    // A gap outranks a resolve: without volume the system cannot claim the cell
    // recovered, so it says so instead of guessing (spec.md §5).
    if (lostVolume) {
      inconclusive.push(incident.incidentId);
    } else {
      resolve.push(incident.incidentId);
    }
  }

  return { resolve, inconclusive };
}

export function createLifecycle(database: Database = defaultDatabase): Lifecycle {
  return {
    async reconcile(input) {
      // One SELECT, then at most two set-based UPDATEs. rules.md §6.8 forbids
      // walking cells with one query each.
      const rows = await database
        .select({
          incidentId: incidents.incidentId,
          detectedAt: incidents.detectedAt,
          dimensions: incidents.dimensions,
        })
        .from(incidents)
        .where(inArray(incidents.status, [...ACTIVE_STATUSES]));

      const transitions = planTransitions({
        bucket: input.bucket,
        active: rows.map((row) => ({
          incidentId: row.incidentId,
          detectedAt: row.detectedAt.toISOString(),
          dimensions: row.dimensions as Record<string, string | undefined>,
        })),
        evidenceGaps: input.evidenceGaps,
      });

      if (transitions.resolve.length > 0) {
        await database
          .update(incidents)
          .set({ status: "resolved", resolvedAt: new Date(input.bucket) })
          .where(
            and(
              inArray(incidents.incidentId, transitions.resolve),
              inArray(incidents.status, [...ACTIVE_STATUSES]),
            ),
          );
      }

      if (transitions.inconclusive.length > 0) {
        await database
          .update(incidents)
          .set({ status: "inconclusive" })
          .where(
            and(
              inArray(incidents.incidentId, transitions.inconclusive),
              inArray(incidents.status, [...ACTIVE_STATUSES]),
            ),
          );
      }

      return transitions;
    },
  };
}
