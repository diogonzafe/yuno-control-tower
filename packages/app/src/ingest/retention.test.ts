import { describe, expect, it } from "vitest";

import { loadRetentionConfig, pruneOnce } from "./retention";

const HOUR_MS = 3_600_000;

function deleterReturning(...counts: number[]) {
  const calls: { cutoff: Date; limit: number }[] = [];
  const deleteBatch = async (cutoff: Date, limit: number) => {
    calls.push({ cutoff, limit });
    return counts[calls.length - 1] ?? 0;
  };
  return { calls, deleteBatch };
}

describe("pruneOnce", () => {
  it("deletes below a cutoff of now minus the retention window", async () => {
    const { calls, deleteBatch } = deleterReturning(0);

    await pruneOnce({
      deleteBatch,
      retentionMs: 3 * HOUR_MS,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      batchSize: 5_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cutoff.toISOString()).toBe("2026-08-30T09:00:00.000Z");
    expect(calls[0]!.limit).toBe(5_000);
  });

  it("stops as soon as a batch comes back short of the batch size", async () => {
    const { calls, deleteBatch } = deleterReturning(100, 100, 40, 100);

    const result = await pruneOnce({
      deleteBatch,
      retentionMs: HOUR_MS,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      batchSize: 100,
      maxBatches: 10,
    });

    expect(calls).toHaveLength(3);
    expect(result).toEqual({ deleted: 240, caughtUp: true });
  });

  it("caps the work per run so a huge backlog is drained across runs, not in one transaction", async () => {
    const { calls, deleteBatch } = deleterReturning(100, 100, 100, 100, 100);

    const result = await pruneOnce({
      deleteBatch,
      retentionMs: HOUR_MS,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      batchSize: 100,
      maxBatches: 3,
    });

    expect(calls).toHaveLength(3);
    expect(result).toEqual({ deleted: 300, caughtUp: false });
  });
});

describe("loadRetentionConfig", () => {
  it("defaults to a window far wider than any stream redelivery, so dedup still holds", () => {
    const config = loadRetentionConfig({});

    // insert-transactions dedups on transaction_id: a redelivered batch is only
    // recognised as a duplicate while its rows are still in the table.
    expect(config.retentionMs).toBeGreaterThanOrEqual(HOUR_MS);
    expect(config.enabled).toBe(true);
  });

  it("reads minutes from the environment", () => {
    const config = loadRetentionConfig({
      TRANSACTIONS_RETENTION_MINUTES: "30",
      TRANSACTIONS_RETENTION_INTERVAL_MINUTES: "5",
    });

    expect(config.retentionMs).toBe(30 * 60_000);
    expect(config.intervalMs).toBe(5 * 60_000);
  });

  it("treats 0 as the operator switching retention off", () => {
    expect(loadRetentionConfig({ TRANSACTIONS_RETENTION_MINUTES: "0" }).enabled).toBe(false);
  });

  it("refuses a value it cannot parse instead of silently falling back", () => {
    expect(() => loadRetentionConfig({ TRANSACTIONS_RETENTION_MINUTES: "soon" })).toThrow(
      /TRANSACTIONS_RETENTION_MINUTES/,
    );
    expect(() => loadRetentionConfig({ TRANSACTIONS_RETENTION_INTERVAL_MINUTES: "-1" })).toThrow(
      /TRANSACTIONS_RETENTION_INTERVAL_MINUTES/,
    );
  });
});
