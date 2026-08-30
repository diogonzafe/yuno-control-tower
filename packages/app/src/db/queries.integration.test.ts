import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "./client.js";
import { rollupMinute } from "./schema.js";
import { createRollupSource, loadMerchantConfigs, loadRoutingCoverage } from "./queries.js";

// 1970 keeps this test impossibly far from both the ~90k rows of real
// retroactive data and anything the live generator writes today. The :05
// minute keeps it clear of ingest/process-batch.integration.test.ts, which
// owns :00 in the same cell and runs in parallel under vitest.
const BUCKET = new Date("1970-01-01T00:05:00.000Z");
const CELL = {
  bucket: BUCKET,
  merchantId: "BR_STORE_01",
  providerId: "adyen",
  country: "BR",
  paymentMethod: "CARD",
  issuerId: "itau",
};

afterEach(async () => {
  await db.delete(rollupMinute).where(
    and(
      eq(rollupMinute.bucket, CELL.bucket),
      eq(rollupMinute.merchantId, CELL.merchantId),
      eq(rollupMinute.providerId, CELL.providerId),
      eq(rollupMinute.country, CELL.country),
      eq(rollupMinute.paymentMethod, CELL.paymentMethod),
      eq(rollupMinute.issuerId, CELL.issuerId),
    ),
  );
});

describe("createRollupSource", () => {
  it("returns the seeded cell as a RollupRow with an ISO bucket and numeric sums", async () => {
    await db.insert(rollupMinute).values({
      ...CELL,
      attempts: 40,
      approved: 10,
      amountMinorSum: 4000,
      amountUsdSum: 800,
      approvedUsdSum: 200,
    });

    const rows = await createRollupSource().getWindowRollups("1970-01-01T00:05:00.000Z");
    const row = rows.find((candidate) => candidate.merchantId === "BR_STORE_01");

    expect(row).toBeDefined();
    expect(row!.bucket).toBe("1970-01-01T00:05:00.000Z");
    expect(row!.attempts).toBe(40);
    expect(row!.approved).toBe(10);
    expect(typeof row!.amountUsdSum).toBe("number");
    expect(row!.amountUsdSum).toBe(800);
    expect(row!.country).toBe("BR");
  });

  it("getHistory returns rows in [from, to) and excludes the upper bound", async () => {
    await db.insert(rollupMinute).values({
      ...CELL,
      attempts: 5,
      approved: 5,
      amountMinorSum: 0,
      amountUsdSum: 0,
      approvedUsdSum: 0,
    });

    const included = await createRollupSource().getHistory(
      "1970-01-01T00:04:30.000Z",
      "1970-01-01T00:06:00.000Z",
    );
    const excluded = await createRollupSource().getHistory(
      "1970-01-01T00:04:30.000Z",
      "1970-01-01T00:05:00.000Z",
    );

    expect(included.some((row) => row.merchantId === "BR_STORE_01")).toBe(true);
    expect(excluded.some((row) => row.merchantId === "BR_STORE_01")).toBe(false);
  });
});

describe("catalog loaders", () => {
  it("loads merchant configs with numeric conversions, never strings", async () => {
    const configs = await loadMerchantConfigs();

    expect(configs.length).toBe(9);
    for (const config of configs) {
      // The whole point: numeric columns arrive as strings from Drizzle, and a
      // string here makes the Wilson comparison silently never fire.
      expect(typeof config.expectedConversion).toBe("number");
      expect(typeof config.minMaterialDropPp).toBe("number");
      expect(config.expectedConversion).toBeGreaterThan(0);
      expect(config.expectedConversion).toBeLessThanOrEqual(1);
    }
  });

  it("loads the 12 DD13 routing coverage rows", async () => {
    const coverage = await loadRoutingCoverage();

    expect(coverage).toHaveLength(12);
    expect(coverage.some((route) => route.paymentMethod === "PIX" && route.country === "BR")).toBe(true);
    expect(coverage.some((route) => route.paymentMethod === "PIX" && route.country !== "BR")).toBe(false);
  });
});
