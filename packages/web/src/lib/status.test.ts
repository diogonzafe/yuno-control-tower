import { expect, test } from "vitest";

import { causeLabel, severityTier, statusBadge } from "./status.ts";

test("severity tiers follow the usd/min thresholds", () => {
  expect(severityTier(29_99)).toBe("ok");
  expect(severityTier(30_00)).toBe("warn");
  expect(severityTier(199_99)).toBe("warn");
  expect(severityTier(200_00)).toBe("critical");
});

test("open incidents badge by severity", () => {
  expect(statusBadge({ status: "open", costUsdPerMin: 5_00 })).toEqual({ tier: "ok", label: "Confirmed" });
  expect(statusBadge({ status: "open", costUsdPerMin: 50_00 })).toEqual({ tier: "warn", label: "Warning" });
  expect(statusBadge({ status: "open", costUsdPerMin: 300_00 })).toEqual({ tier: "critical", label: "Critical" });
});

test("cause label distinguishes an isolated cause from a bare detection", () => {
  expect(causeLabel("CONFIRMED")).toEqual({ isolated: true, label: "Cause isolated" });
  expect(causeLabel("INCONCLUSIVE")).toEqual({ isolated: false, label: "Cause not isolated" });
});

test("cause label stays silent for evidence written before the verdict existed", () => {
  expect(causeLabel(undefined)).toBe(null);
});

test("non-open incidents badge by status, regardless of cost", () => {
  expect(statusBadge({ status: "monitoring", costUsdPerMin: 300_00 })).toEqual({ tier: "monitoring", label: "Monitoring" });
  expect(statusBadge({ status: "resolved", costUsdPerMin: 0 })).toEqual({ tier: "resolved", label: "Resolved" });
  expect(statusBadge({ status: "inconclusive", costUsdPerMin: 0 })).toEqual({ tier: "inconclusive", label: "Inconclusive" });
});
