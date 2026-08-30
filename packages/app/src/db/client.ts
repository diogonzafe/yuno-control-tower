import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — check .env");
}

export const sql = postgres(databaseUrl, { ssl: "prefer" });
export const db = drizzle(sql, { schema });
