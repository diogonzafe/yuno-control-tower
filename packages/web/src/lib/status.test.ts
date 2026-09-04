import test from "node:test";
import assert from "node:assert/strict";

import { causeLabel, severityTier, statusBadge } from "./status.ts";

test("severity tiers follow the usd/min thresholds", () => {
  assert.equal(severityTier(29_99), "ok");
  assert.equal(severityTier(30_00), "warn");
  assert.equal(severityTier(199_99), "warn");
  assert.equal(severityTier(200_00), "critical");
});

test("open incidents badge by severity", () => {
  assert.deepEqual(statusBadge({ status: "open", costUsdPerMin: 5_00 }), { tier: "ok", label: "Confirmed" });
  assert.deepEqual(statusBadge({ status: "open", costUsdPerMin: 50_00 }), { tier: "warn", label: "Warning" });
  assert.deepEqual(statusBadge({ status: "open", costUsdPerMin: 300_00 }), { tier: "critical", label: "Critical" });
});

test("cause label distinguishes an isolated cause from a bare detection", () => {
  assert.deepEqual(causeLabel("CONFIRMED"), { isolated: true, label: "Cause isolated" });
  assert.deepEqual(causeLabel("INCONCLUSIVE"), { isolated: false, label: "Cause not isolated" });
});

test("cause label stays silent for evidence written before the verdict existed", () => {
  assert.equal(causeLabel(undefined), null);
});

test("non-open incidents badge by status, regardless of cost", () => {
  assert.deepEqual(statusBadge({ status: "monitoring", costUsdPerMin: 300_00 }), { tier: "monitoring", label: "Monitoring" });
  assert.deepEqual(statusBadge({ status: "resolved", costUsdPerMin: 0 }), { tier: "resolved", label: "Resolved" });
  assert.deepEqual(statusBadge({ status: "inconclusive", costUsdPerMin: 0 }), { tier: "inconclusive", label: "Inconclusive" });
});
