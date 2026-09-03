"use client";

import { useState } from "react";
import { useActiveInjections } from "../../lib/use-active-injections";
import { useCatalog } from "../../lib/use-catalog";
import { useControlTowerStream } from "../../lib/use-control-tower-stream";
import type { Audience } from "../../lib/narrative";
import { EvidencePanel } from "./evidence-panel";
import { IncidentFeed } from "./incident-feed";
import { LiveChart } from "./live-chart";
import { TopBar } from "./top-bar";

export function ControlTower() {
  const { snapshot, connected, streamError } = useControlTowerStream();
  const { catalog } = useCatalog();
  const { active: activeInjections } = useActiveInjections();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>("operations");

  const loading = snapshot === null;
  const incidents = snapshot?.incidents ?? [];
  const openIncidents = incidents.filter((incident) => incident.status === "open");
  const selected = incidents.find((incident) => incident.incidentId === selectedId) ?? null;

  return (
    <div className={`ct-shell ${selected ? "ct-shell--split" : ""}`}>
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
          <LiveChart series={snapshot?.providerSeries ?? []} catalog={catalog} injections={activeInjections} />
          <IncidentFeed
            loading={loading}
            incidents={openIncidents}
            pendingSignals={snapshot?.pendingSignals ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
            catalog={catalog}
          />
        </div>
      </main>

      {selected && <EvidencePanel incident={selected} catalog={catalog} audience={audience} />}
    </div>
  );
}
