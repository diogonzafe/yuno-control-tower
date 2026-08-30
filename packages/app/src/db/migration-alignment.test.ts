import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const drizzleDir = resolve(import.meta.dirname, "../../../..", "drizzle");

type Journal = { entries: Array<{ idx: number; tag: string }> };

function journal(): Journal {
  return JSON.parse(readFileSync(resolve(drizzleDir, "meta/_journal.json"), "utf8")) as Journal;
}

// The failure this guards against actually happened: 0003 was written, committed
// and never registered, so `drizzle-kit migrate` skipped it and the running app
// selected columns the database did not have — it crashed on boot, before
// serving anything. Asserting the SQL text (what this file used to do) cannot
// catch that; only the journal can.
describe("drizzle migration registration", () => {
  it("registers every .sql migration in the journal", () => {
    const files = readdirSync(drizzleDir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    const registered = journal().entries.map((entry) => entry.tag).sort();

    expect(registered).toEqual(files);
  });

  it("numbers journal entries contiguously from zero, in file order", () => {
    const entries = journal().entries;

    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
    expect([...entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag)).toEqual(
      entries.map((entry) => entry.tag),
    );
  });

  it("keeps a snapshot alongside every registered migration", () => {
    const snapshots = readdirSync(resolve(drizzleDir, "meta"))
      .filter((name) => name.endsWith("_snapshot.json"));

    for (const entry of journal().entries) {
      const index = String(entry.idx).padStart(4, "0");
      expect(snapshots).toContain(`${index}_snapshot.json`);
    }
  });
});
