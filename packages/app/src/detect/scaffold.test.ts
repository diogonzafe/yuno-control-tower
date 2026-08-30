import { describe, expect, it } from "vitest";
import * as constants from "./constants.js";
import type { Dimension, RollupRow, SliceFilter } from "./types.js";
import type { RollupSource } from "../db/queries.js";

describe("detector scaffold", () => {
  it("uses the locked detector constants and data seams", () => {
    expect(constants).toMatchObject({ MIN_VOLUME: 30, Z: 1.96, DELTA_PP_DEFAULT: 3, PERSISTENCE_WINDOWS: 3, THIN_CELL_WINDOW_MIN: 5, ONSET_LOOKBACK_MIN: 120, TEMPORAL_LOOKBACK_MIN: 360 });
    const row = {} as RollupRow, filter: SliceFilter = { merchantId: "BR_STORE_01" }, dim: Dimension = "issuerId";
    const source: RollupSource = { getWindowRollups: async () => [row], getHistory: async () => [row] };
    expect([filter.merchantId, dim, typeof source.getHistory]).toEqual(["BR_STORE_01", "issuerId", "function"]);
  });
});
