import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rollupMinute, rollupDeclinesMinute } from "../db/schema";
import { upsertRollupDeclinesMinute, upsertRollupMinute } from "./upsert-rollups";
import type { RollupDeclineDelta, RollupMinuteDelta } from "./rollup";

const TEST_BUCKET = new Date("2026-08-30T14:05:00.000Z");
const TEST_CELL = {
  bucket: TEST_BUCKET,
  merchantId: "merchant-upsert-test",
  providerId: "adyen",
  country: "BR" as const,
  paymentMethod: "CARD" as const,
  issuerId: "itau",
};

async function cleanup() {
  await db
    .delete(rollupMinute)
    .where(
      and(
        eq(rollupMinute.bucket, TEST_BUCKET),
        eq(rollupMinute.merchantId, TEST_CELL.merchantId),
      ),
    );
  await db
    .delete(rollupDeclinesMinute)
    .where(
      and(
        eq(rollupDeclinesMinute.bucket, TEST_BUCKET),
        eq(rollupDeclinesMinute.merchantId, TEST_CELL.merchantId),
      ),
    );
}

afterEach(cleanup);

describe("upsertRollupMinute", () => {
  it("inserts a new cell", async () => {
    const delta: RollupMinuteDelta = {
      ...TEST_CELL,
      attempts: 3,
      approved: 2,
      amountMinorSum: 3000,
      amountUsdSum: 600,
      approvedUsdSum: 400,
    };

    await upsertRollupMinute(db, [delta]);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(
        and(
          eq(rollupMinute.bucket, TEST_BUCKET),
          eq(rollupMinute.merchantId, TEST_CELL.merchantId),
        ),
      );
    expect(row).toMatchObject({ attempts: 3, approved: 2, amountMinorSum: 3000 });
  });

  it("adds to an existing cell instead of overwriting it", async () => {
    const first: RollupMinuteDelta = {
      ...TEST_CELL,
      attempts: 3,
      approved: 2,
      amountMinorSum: 3000,
      amountUsdSum: 600,
      approvedUsdSum: 400,
    };
    const second: RollupMinuteDelta = {
      ...TEST_CELL,
      attempts: 1,
      approved: 0,
      amountMinorSum: 500,
      amountUsdSum: 100,
      approvedUsdSum: 0,
    };

    await upsertRollupMinute(db, [first]);
    await upsertRollupMinute(db, [second]);

    const [row] = await db
      .select()
      .from(rollupMinute)
      .where(
        and(
          eq(rollupMinute.bucket, TEST_BUCKET),
          eq(rollupMinute.merchantId, TEST_CELL.merchantId),
        ),
      );
    expect(row).toMatchObject({ attempts: 4, approved: 2, amountMinorSum: 3500 });
  });
});

describe("upsertRollupDeclinesMinute", () => {
  it("adds counts per decline_code instead of overwriting", async () => {
    const delta: RollupDeclineDelta = { ...TEST_CELL, declineCode: "05", count: 2 };

    await upsertRollupDeclinesMinute(db, [delta]);
    await upsertRollupDeclinesMinute(db, [{ ...delta, count: 1 }]);

    const [row] = await db
      .select()
      .from(rollupDeclinesMinute)
      .where(
        and(
          eq(rollupDeclinesMinute.bucket, TEST_BUCKET),
          eq(rollupDeclinesMinute.merchantId, TEST_CELL.merchantId),
          eq(rollupDeclinesMinute.declineCode, "05"),
        ),
      );
    expect(row?.count).toBe(3);
  });
});
