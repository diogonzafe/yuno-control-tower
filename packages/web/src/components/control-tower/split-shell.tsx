"use client";

import type { ReactNode } from "react";
import type { Catalog, IncidentRow } from "@control-tower/app";
import type { Audience } from "../../lib/narrative";
import { EvidencePanel } from "./evidence-panel";

/**
 * The page shell that grows a second column when an incident is selected.
 *
 * `ct-shell--split` is what opens the column and `EvidencePanel` is what fills
 * it, so the two have to be decided by the same condition: a page that sets one
 * without the other renders an empty column or a panel with nowhere to sit.
 * Both the dashboard and the history page need it, so the invariant lives here
 * rather than being restated at each call site.
 */
export function SplitShell({
  selected,
  catalog,
  audience = "operations",
  children,
}: {
  selected: IncidentRow | null;
  catalog: Catalog | null;
  audience?: Audience;
  children: ReactNode;
}) {
  return (
    <div className={`ct-shell ${selected ? "ct-shell--split" : ""}`}>
      {children}
      {selected && <EvidencePanel incident={selected} catalog={catalog} audience={audience} />}
    </div>
  );
}
