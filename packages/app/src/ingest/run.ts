import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env before importing ./consumer: a static top-level import would be
// hoisted by ESM and evaluated before this config() call, and ./consumer's
// transitive dependency on db/client.ts reads DATABASE_URL at module-load
// time, so a static import here would crash with "DATABASE_URL is not set"
// even when .env exists. The dynamic import defers that evaluation until
// after the environment is loaded.
config({ path: resolve(import.meta.dirname, "../../../../.env") });

const { startConsumer } = await import("./consumer");

startConsumer().catch((error) => {
  console.error("ingest consumer crashed:", error);
  process.exit(1);
});
