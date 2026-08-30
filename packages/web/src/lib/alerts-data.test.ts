import test from "node:test";
import assert from "node:assert/strict";

import { buildInjectedIncident } from "./alerts-data.ts";

test("builds a transparent simulated incident from the jury-selected dimensions", () => {
  const incident = buildInjectedIncident({
    merchant: "Shopline LatAm",
    provider: "Stripe",
    country: "MX",
    paymentMethod: "CARD",
    issuer: "BBVA",
    declineCode: "ISSUER_UNAVAILABLE",
  });

  assert.match(incident.title, /Stripe.*MX/);
  assert.match(incident.dimensions, /issuer=BBVA/);
  assert.equal(incident.status, "OPEN");
  assert.equal(incident.isSimulated, true);
});
