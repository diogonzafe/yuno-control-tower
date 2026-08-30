import { config } from "dotenv";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Monorepo-wide secrets (DATABASE_URL, REDIS_URL) live in the root .env, not
// packages/web's own — Next only auto-loads the latter, so API routes that
// import @control-tower/app (and therefore db/client.ts) need this to run
// before anything reads process.env.
config({ path: resolve(import.meta.dirname, "../../.env") });

const nextConfig: NextConfig = {
  // The demo is opened from another device on the local network.
  allowedDevOrigins: ["192.168.11.209"],
  transpilePackages: ["@control-tower/app", "@control-tower/contracts"],
};

export default nextConfig;
