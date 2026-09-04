import { defineConfig, devices } from "@playwright/test";

// The suite drives the deployed Railway environment. Nothing is started
// locally: the detector needs a live generator, a live Redis stream and minutes
// of real rollups behind it, and a `next dev` pointed at fixtures would assert
// against hand-written JSON instead of the pipeline the jury will actually see.
const BASE_URL = process.env.E2E_BASE_URL ?? "https://web-production-16ca8.up.railway.app";

export default defineConfig({
  testDir: "./e2e",
  // One shared deployment, and the scenario specs inject real faults into it.
  // In parallel, one spec's injection would decide another spec's assertions.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The console holds an SSE connection open; without this the default
    // navigation wait sits on it until it times out.
    navigationTimeout: 45_000,
  },
  projects: [
    {
      // Read-only against whatever the deployment currently shows. Safe to run
      // at any time, including mid-demo.
      name: "ui",
      testIgnore: /scenarios\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
      timeout: 90_000,
    },
    {
      // Injects faults and waits for the detector's 3-window persistence plus
      // the orchestrator's own tick. Minutes, not seconds — and it changes what
      // the dashboard shows while it runs.
      name: "scenarios",
      testMatch: /scenarios\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
      timeout: 20 * 60 * 1000,
    },
  ],
});
