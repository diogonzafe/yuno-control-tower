"use client";

import { useCatalog } from "../../lib/use-catalog";
import { InjectConsole } from "./inject-console";
import { MerchantSettings } from "./merchant-settings";

export function ConsolePage() {
  const { catalog, failed: catalogFailed } = useCatalog();

  return (
    <div className="ct-page">
      <div className="ct-page__inner ct-page__inner--wide">
        <div className="ct-history__head">
          <h1>Jury console</h1>
          <p>Operator tools: set the baseline every merchant is measured against, and inject a conversion drop to watch the detector confirm it live on the dashboard.</p>
        </div>

        <div className="ct-console-grid">
          <MerchantSettings />
          <InjectConsole catalog={catalog} catalogFailed={catalogFailed} />
        </div>
      </div>
    </div>
  );
}
