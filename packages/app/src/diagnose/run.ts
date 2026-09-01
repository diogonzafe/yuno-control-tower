import type { ConfirmedDrop, ExpectedSource } from "@control-tower/contracts";
import type { MerchantConfig, RollupRow, RoutingCoverage, SliceFilter } from "../detect/types.js";
import type { Interval } from "../detect/wilson.js";
import { DELTA_PP_DEFAULT } from "../detect/constants.js";
import { onsetScan } from "../detect/onset-scan.js";
import { estimateImpact, type Impact } from "./cost.js";
import { declineMixShift, disambiguateOutage, type DeclineMix, type OutageAttribution } from "./decline-mix.js";
import { peel, type Echo } from "./peeling.js";
import { residualDeficit } from "./residual.js";
import type { DeclineCode, DeclineRollupRow } from "./types.js";

export type DiagnoseInput = {
  signals: ConfirmedDrop[];
  windowBucket: string;
  rollups: RollupRow[];
  declines: DeclineRollupRow[];
  declineHistory: DeclineRollupRow[];
  merchants: MerchantConfig[];
  coverage: RoutingCoverage;
  catalog: DeclineCode[];
};

export type CausalDimension = "provider" | "issuer" | "method" | "merchant";

export type Diagnosis = {
  root: SliceFilter;
  cell: SliceFilter;
  causalDimension: CausalDimension;
  confidence: "CONFIRMED" | "INCONCLUSIVE";
  windowBucket: string;
  startedAt: string;
  startedAtExact: boolean;
  attempts: number;
  approved: number;
  observedRate: number;
  expectedRate: number;
  // Where `expectedRate` came from: a peeled cell is measured against its
  // siblings in the same window, while the root that never split is measured
  // against the merchant's configured constant (DD7).
  expectedSource: ExpectedSource;
  deltaPp: number;
  ci: Interval;
  ciLevel: number;
  // Diagnosis only ever reads the closed one-minute window; the detector's 5m
  // widening for thin cells (THIN_CELL_WINDOW_MIN) happens before this stage.
  windowUsed: "1m" | "5m";
  consecutiveWindows: number;
  explainedDeficit: number;
  declineMix: DeclineMix | null;
  outageAttribution: OutageAttribution | null;
  impact: Impact;
  suppressedEchoes: Echo[];
};

// 91 and AB03 are the two codes whose spread, not whose presence, names the
// culprit (schema.md §8).
const OUTAGE_CODES = new Set(["91", "AB03"]);

type Root = { root: SliceFilter; consecutiveWindows: number; rootSignal: ConfirmedDrop | null };

// Several signals collapse onto one merchant x country root (DD17): the
// provider that tripped the cross-sectional cut and the root that tripped the
// absolute one are the same incident. The oldest confirmation among them is
// the one that answers "how long has this been going on".
//
// `rootSignal` keeps the narrowest-dimensioned signal among those collapsed
// onto this root — an exact {merchantId, country} absoluteTrigger signal when
// one exists, otherwise whichever cross-sectional signal (e.g. + paymentMethod)
// stayed closest to the root. Fewer dimensions reads as "closer to the root"
// because every extra key only narrows what a signal measures. It is what the
// no-peel branch below trusts instead of re-deriving MATERIAL_DROP from this
// tick's single window alone.
function rootsOf(signals: ConfirmedDrop[]): Root[] {
  const roots = new Map<string, Root>();
  for (const signal of signals) {
    const { merchantId, country } = signal.dimensions;
    if (merchantId === undefined || country === undefined) continue;
    const key = `${merchantId}|${country}`;
    const previous = roots.get(key);
    const keepPrevious = previous?.rootSignal !== undefined
      && previous.rootSignal !== null
      && Object.keys(previous.rootSignal.dimensions).length <= Object.keys(signal.dimensions).length;
    roots.set(key, {
      root: { merchantId, country },
      consecutiveWindows: Math.max(previous?.consecutiveWindows ?? 0, signal.consecutiveWindows),
      rootSignal: keepPrevious ? previous!.rootSignal : signal,
    });
  }
  return [...roots.values()];
}

function causalDimension(cell: SliceFilter, attribution: OutageAttribution | null): CausalDimension {
  // The spread of an outage code outranks the shape of the cell: a provider
  // losing connectivity shows up in one issuer's slice first.
  if (attribution === "PROVIDER") return "provider";
  if (attribution === "ISSUER") return "issuer";
  if (cell.issuerId !== undefined) return "issuer";
  if (cell.providerId !== undefined) return "provider";
  if (cell.paymentMethod !== undefined) return "method";
  return "merchant";
}

function minutesBefore(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

function explain(
  input: DiagnoseInput,
  cell: SliceFilter,
): { declineMix: DeclineMix | null; outageAttribution: OutageAttribution | null } {
  const mix = declineMixShift(input.declines, cell, input.windowBucket, input.catalog, input.declineHistory);
  if (mix.totalDeclines === 0) return { declineMix: null, outageAttribution: null };

  const dominant = mix.dominantCode;
  if (dominant === null || !OUTAGE_CODES.has(dominant)) {
    return { declineMix: mix, outageAttribution: null };
  }
  // The spread has to be read wider than the causal cell: a provider outage is
  // only visible once several issuers are in view.
  const from = minutesBefore(input.windowBucket, mix.windowUsed - 1);
  const windowed = input.declines.filter((row) => row.bucket >= from && row.bucket <= input.windowBucket);
  const scope = { merchantId: cell.merchantId, country: cell.country };
  return { declineMix: mix, outageAttribution: disambiguateOutage(windowed, scope, dominant) };
}

export function runDiagnosis(input: DiagnoseInput): Diagnosis[] {
  const windowRows = input.rollups.filter((row) => row.bucket === input.windowBucket);
  const diagnoses: Diagnosis[] = [];

  for (const { root, consecutiveWindows, rootSignal } of rootsOf(input.signals)) {
    const merchant = input.merchants.find((entry) => entry.merchantId === root.merchantId);
    if (merchant === undefined) continue;
    const expected = merchant.expectedConversion;
    const deltaPp = merchant.minMaterialDropPp ?? DELTA_PP_DEFAULT;

    const peels = peel(windowRows, root, expected, deltaPp, input.coverage);

    if (peels.length === 0) {
      // The root is materially down yet no child separates from its siblings:
      // say so instead of promoting the least innocent cell (spec.md §5).
      const onset = onsetScan(input.rollups, root, input.windowBucket, expected, deltaPp);

      if (rootSignal !== null) {
        // A root-level signal already confirmed MATERIAL_DROP over
        // `consecutiveWindows` persisted windows (detect/persistence.ts) —
        // trust those already-validated numbers instead of re-deriving state
        // from this tick's single window alone. A lone noisy minute can read
        // as WITHIN_NORMAL or INSUFFICIENT_EVIDENCE by chance even while the
        // drop is real and ongoing (the same class of noise persistence.ts's
        // gap-tolerant fix already accounts for on the detection side); redoing
        // the check here on one window silently dropped the diagnosis — and
        // with it the incident — whenever that happened.
        diagnoses.push({
          root,
          cell: root,
          causalDimension: "merchant",
          confidence: "INCONCLUSIVE",
          windowBucket: input.windowBucket,
          ...onset,
          attempts: rootSignal.attempts,
          approved: rootSignal.approved,
          observedRate: rootSignal.observedRate,
          expectedRate: rootSignal.expectedRate,
          expectedSource: rootSignal.expectedSource,
          deltaPp,
          ci: { low: rootSignal.ciLow, high: rootSignal.ciHigh },
          ciLevel: rootSignal.ciLevel,
          windowUsed: rootSignal.windowUsed,
          consecutiveWindows,
          explainedDeficit: Math.max(0, rootSignal.attempts * expected - rootSignal.approved),
          declineMix: null,
          outageAttribution: null,
          impact: estimateImpact(input.rollups, root, expected, onset.startedAt, input.windowBucket),
          suppressedEchoes: [],
        });
        continue;
      }

      // No root-level signal collapsed here — only narrower cross-sectional
      // ones did (DD17) — so there is no already-validated root reading to
      // trust. Fall back to deriving one from this tick's window, as before.
      const residual = residualDeficit(windowRows, root, expected, deltaPp);
      if (residual.state !== "MATERIAL_DROP") continue;
      diagnoses.push({
        root,
        cell: root,
        causalDimension: "merchant",
        confidence: "INCONCLUSIVE",
        windowBucket: input.windowBucket,
        ...onset,
        attempts: residual.attempts,
        approved: residual.approved,
        observedRate: residual.rate ?? 0,
        expectedRate: expected,
        expectedSource: "absolute",
        deltaPp,
        ci: residual.ci,
        ciLevel: 0.95,
        windowUsed: "1m",
        consecutiveWindows,
        explainedDeficit: residual.deficit,
        declineMix: null,
        outageAttribution: null,
        impact: estimateImpact(input.rollups, root, expected, onset.startedAt, input.windowBucket),
        suppressedEchoes: [],
      });
      continue;
    }

    for (const { causal, suppressedEchoes } of peels) {
      const onset = onsetScan(input.rollups, causal.cell, input.windowBucket, causal.expectedRate, deltaPp);
      const { declineMix, outageAttribution } = explain(input, causal.cell);
      diagnoses.push({
        root,
        cell: causal.cell,
        causalDimension: causalDimension(causal.cell, outageAttribution),
        confidence: "CONFIRMED",
        windowBucket: input.windowBucket,
        ...onset,
        attempts: causal.attempts,
        approved: causal.approved,
        observedRate: causal.observedRate,
        expectedRate: causal.expectedRate,
        expectedSource: "cross_sectional",
        deltaPp,
        ci: causal.ci,
        ciLevel: 0.95,
        windowUsed: "1m",
        consecutiveWindows,
        explainedDeficit: causal.explainedDeficit,
        declineMix,
        outageAttribution,
        impact: estimateImpact(
          input.rollups,
          causal.cell,
          causal.expectedRate,
          onset.startedAt,
          input.windowBucket,
        ),
        suppressedEchoes,
      });
    }
  }

  return diagnoses.sort((a, b) => b.impact.priorityScore - a.impact.priorityScore);
}
