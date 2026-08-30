import { describe, expect, it } from "vitest";
import { sql } from "./client";

describe("db client", () => {
  it("connects to the database configured in .env", async () => {
    const rows = await sql<{ one: number }[]>`select 1 as one`;
    expect(rows[0]?.one).toBe(1);
  });
});
