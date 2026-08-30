import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "./client.js";
import { rollupDeclinesMinute, rollupMinute } from "./schema.js";
import {
  createDeclineSource,
  createRollupSource,
  loadDeclineCatalog,
  loadMerchantConfigs,
  loadRoutingCoverage,
} from "./queries.js";

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

  it("loads the DD21 decline catalog with numeric shares, never strings", async () => {
    const catalog = await loadDeclineCatalog();

    expect(catalog.length).toBeGreaterThan(0);
    const entry = catalog.find((code) => code.code === "05");
    expect(entry).toBeDefined();
    expect(entry!.family).toBe("issuer");
    expect(typeof entry!.baselineShare).toBe("number");
    expect(entry!.diagnostic).toBe(true);
  });
});

describe("createDeclineSource", () => {
  const DECLINE_BUCKET = new Date("1970-01-01T00:05:00.000Z");
  const DECLINE_CELL = { ...CELL, bucket: DECLINE_BUCKET, declineCode: "TEST-05" };

  afterEach(async () => {
    await db.delete(rollupDeclinesMinute).where(
      and(
        eq(rollupDeclinesMinute.bucket, DECLINE_CELL.bucket),
        eq(rollupDeclinesMinute.merchantId, DECLINE_CELL.merchantId),
        eq(rollupDeclinesMinute.providerId, DECLINE_CELL.providerId),
        eq(rollupDeclinesMinute.country, DECLINE_CELL.country),
        eq(rollupDeclinesMinute.paymentMethod, DECLINE_CELL.paymentMethod),
        eq(rollupDeclinesMinute.issuerId, DECLINE_CELL.issuerId),
        eq(rollupDeclinesMinute.declineCode, DECLINE_CELL.declineCode),
      ),
    );
  });

  it("returns the seeded cell as a DeclineRollupRow with an ISO bucket", async () => {
    await db.insert(rollupDeclinesMinute).values({ ...DECLINE_CELL, count: 7 });

    const rows = await createDeclineSource().getWindowDeclines("1970-01-01T00:05:00.000Z");
    const row = rows.find((candidate) => candidate.declineCode === "TEST-05");

    expect(row).toBeDefined();
    expect(row!.bucket).toBe("1970-01-01T00:05:00.000Z");
    expect(row!.count).toBe(7);
    expect(row!.country).toBe("BR");
  });

  it("getHistory returns rows in [from, to) and excludes the upper bound", async () => {
    await db.insert(rollupDeclinesMinute).values({ ...DECLINE_CELL, count: 3 });

    const included = await createDeclineSource().getHistory(
      "1970-01-01T00:04:30.000Z",
      "1970-01-01T00:06:00.000Z",
    );
    const excluded = await createDeclineSource().getHistory(
      "1970-01-01T00:04:30.000Z",
      "1970-01-01T00:05:00.000Z",
    );

    expect(included.some((row) => row.declineCode === "TEST-05")).toBe(true);
    expect(excluded.some((row) => row.declineCode === "TEST-05")).toBe(false);
  });
});
