import { describe, expect, test } from "vitest";
import { fullCoverage } from "../detect/fixtures.js";
import {
  BR_ROOT,
  BUCKET,
  DECLINE_CATALOG,
  DIAGNOSE_MERCHANTS,
  brFlatDropGrid,
  brFullGrid,
  confirmedDrop,
  declineRow,
} from "./fixtures.js";
import { runDiagnosis, type Diagnosis } from "./run.js";
import type { DeclineRollupRow } from "./types.js";
import { buildTrail } from "./trail.js";

const NO_DECLINES: DeclineRollupRow[] = [];

const base = {
  windowBucket: BUCKET,
  declines: NO_DECLINES,
  declineHistory: [],
  merchants: DIAGNOSE_MERCHANTS,
  coverage: fullCoverage(),
  catalog: DECLINE_CATALOG,
};

function diagnose(rollups = brFullGrid(), declines = base.declines): Diagnosis {
  const [diagnosis] = runDiagnosis({
    ...base,
    signals: [confirmedDrop(BR_ROOT)],
    rollups,
    declines,
  });
  return diagnosis!;
}

describe("buildTrail", () => {
  test("walks one step per dimension the diagnosis fixed, then the residual test", () => {
    const trail = buildTrail(brFullGrid(), diagnose());

    expect(trail.map((step) => step.toolName)).toEqual([
      "query_conversion_slice",
      "query_conversion_slice",
      "query_conversion_slice",
      "run_residual_test",
    ]);
    expect(trail.map((step) => step.stepNo)).toEqual([1, 2, 3, 4]);
    expect(trail.every((step) => step.toolCallId.startsWith("fallback:"))).toBe(true);
  });

  test("each drill-down step names the dimension it split and the value it fixed", () => {
    const trail = buildTrail(brFullGrid(), diagnose());

    expect(trail.map((step) => (step.toolArgs as { splitBy?: string }).splitBy)).toEqual([
      "providerId",
      "paymentMethod",
      "issuerId",
      undefined,
    ]);
    expect(
      trail.map((step) => (step.toolResult as { fixed?: string } | null)?.fixed),
    ).toEqual([
      "adyen",
      "CARD",
      "itau",
      undefined,
    ]);
  });

  test("shows the sibling rates that made the choice defensible", () => {
    const [first] = buildTrail(brFullGrid(), diagnose());

    // adyen carries 300/30 against two healthy card cells and a healthy PIX
    // cell: 316 of 600. Its siblings sit at 381 of 400.
    expect((first!.toolResult as { rates: Record<string, number> }).rates).toEqual({
      adyen: 316 / 600,
      stripe: 381 / 400,
      mercado_pago: 381 / 400,
    });
  });

  test("records what the residual test cleared", () => {
    const trail = buildTrail(brFullGrid(), diagnose());
    const residual = trail.find((step) => step.toolName === "run_residual_test");

    expect((residual!.toolResult as { suppressed: unknown[] }).suppressed).toContainEqual({
      cell: { merchantId: "BR_STORE_01", country: "BR", providerId: "adyen" },
      observedRate: 316 / 600,
      residualRate: 286 / 300,
    });
  });

  test("adds the decline mix as its own step when the cell has one", () => {
    const declines = [
      declineRow({ declineCode: "05", count: 78 }),
      declineRow({ declineCode: "51", count: 20 }),
      declineRow({ declineCode: "91", count: 2 }),
    ];
    const trail = buildTrail(brFullGrid(), diagnose(brFullGrid(), declines));

    const mix = trail.at(-1);
    expect(mix!.toolName).toBe("query_decline_mix");
    expect((mix!.toolResult as { dominantCode: string }).dominantCode).toBe("05");
  });

  test("sweeps every free dimension when nothing stood out, fixing none of them", () => {
    const trail = buildTrail(brFlatDropGrid(), diagnose(brFlatDropGrid()));

    expect(trail.map((step) => (step.toolArgs as { splitBy?: string }).splitBy)).toEqual([
      "providerId",
      "paymentMethod",
      "issuerId",
      undefined,
    ]);
    expect(
      trail.every((step) => (step.toolResult as { fixed?: string } | null)?.fixed === undefined),
    ).toBe(true);
  });
});
