import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — check .env");
}

// idle_timeout / max_lifetime: DATABASE_URL and REDIS_URL point at managed
// services outside Railway (this project has no Postgres/Redis service), so
// every connection crosses the public internet and a long-lived idle socket
// gets reset by the provider or an intermediary — surfacing as an
// uncaught `read ECONNRESET` that crash-loops the process. Recycling
// connections ourselves (close after 20s idle, retire after 30min) means the
// driver reconnects on its own schedule instead of discovering a dead socket
// mid-query.
export const sql = postgres(databaseUrl, {
  ssl: "prefer",
  idle_timeout: 20,
  max_lifetime: 60 * 30,
});
export const db = drizzle(sql, { schema });
