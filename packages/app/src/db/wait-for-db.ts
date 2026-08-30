import { createLogger } from "../logging.js";
import { sql } from "./client.js";

const logger = createLogger("db");

// Postgres keeps refusing queries for a few seconds after it starts accepting
// TCP — every one fails with SQLSTATE 57P03, "the database system is not yet
// accepting connections". On a joint redeploy the app reliably wins that race,
// and the first real query (coordinator.recoverOrphanRuns() in run.ts) is a
// top-level await, so the rejection becomes an uncaughtException and the
// process crash-loops until Railway marks the deployment CRASHED. Gate startup
// on a trivial query with a bounded backoff instead: absorb the boot race, but
// still fail loudly if the database is genuinely unreachable.
const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sql`select 1`;
      if (attempt > 1) {
        logger.info({ attempt }, "database ready");
      }
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        logger.fatal({ error, attempt }, "database still unreachable after retries, giving up");
        throw error;
      }
      // 1s, 2s, 3s ... capped at 10s — ~55s of total grace before the throw.
      const delayMs = Math.min(BASE_DELAY_MS * attempt, MAX_DELAY_MS);
      logger.warn({ error, attempt, delayMs }, "database not ready, retrying");
      await sleep(delayMs);
    }
  }
}
