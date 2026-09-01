"use client";

import { useEffect, useState } from "react";
import { useCatalog } from "../../lib/use-catalog";
import { useControlTowerStream } from "../../lib/use-control-tower-stream";
import type { Audience } from "../../lib/narrative";
import { EvidencePanel } from "./evidence-panel";
import { IncidentFeed } from "./incident-feed";
import { InjectConsole } from "./inject-console";
import { LiveChart } from "./live-chart";
import { MerchantSettings } from "./merchant-settings";
import { TopBar } from "./top-bar";

export function ControlTower() {
  const { snapshot, connected, streamError } = useControlTowerStream();
  const { catalog, failed: catalogFailed } = useCatalog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>("operations");

  const loading = snapshot === null;
  const incidents = snapshot?.incidents ?? [];
  const openIncidents = incidents.filter((incident) => incident.status === "open");
  const historyIncidents = incidents
    .filter((incident) => incident.status !== "open")
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));

  const incidentIds = incidents.map((incident) => incident.incidentId).join(",");
  useEffect(() => {
    if (selectedId && incidents.some((incident) => incident.incidentId === selectedId)) return;
    setSelectedId(openIncidents[0]?.incidentId ?? null);
  }, [incidentIds]);

  const selected = incidents.find((incident) => incident.incidentId === selectedId) ?? null;

  return (
    <div className="ct-shell">
      <div className="ct-sidebar-stack">
        <MerchantSettings />
        <InjectConsole catalog={catalog} catalogFailed={catalogFailed} />
      </div>

      <main className="ct-main">
        <TopBar
          loading={loading}
          connected={connected}
          streamError={streamError}
          openCount={openIncidents.length}
          audience={audience}
          onAudienceChange={setAudience}
        />
        <div className="ct-scroll">
          <LiveChart series={snapshot?.providerSeries ?? []} catalog={catalog} />
          <IncidentFeed
            loading={loading}
            incidents={openIncidents}
            history={historyIncidents}
            selectedId={selectedId}
            onSelect={setSelectedId}
            catalog={catalog}
          />
        </div>
      </main>

      <EvidencePanel incident={selected} catalog={catalog} audience={audience} />
    </div>
  );
}
