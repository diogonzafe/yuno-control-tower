"use client";

import type { Audience } from "../../lib/narrative";
import { Term } from "./term";

export function TopBar({
  loading,
  connected,
  streamError,
  activeCount,
  audience,
  onAudienceChange,
}: {
  loading: boolean;
  connected: boolean;
  streamError: string | null;
  activeCount: number;
  audience: Audience;
  onAudienceChange: (audience: Audience) => void;
}) {
  const statusLabel = loading ? "Connecting…" : connected ? "Monitoring" : "Reconnecting…";

  return (
    <header className="ct-topbar">
      <div className="ct-topbar__left">
        <div className="ct-health">
          <i className={connected ? "" : "ct-health__dot--warn"} />
          <span>{statusLabel}</span>
          <span>{activeCount} active</span>
        </div>
        <span className="ct-meta">
          <Term title="Raw transactions are aggregated into 1-minute buckets before any rate is compared.">rollup_minute</Term>
          {" · "}
          <Term title="A 95% Wilson score interval: a confidence range for the true approval rate given the sample size, more honest than a plain percentage at low volume.">Wilson 95% CI</Term>
          {" · "}
          <Term title="A drop must confirm across 2 consecutive detection windows before it becomes an incident, so single-window noise doesn't page anyone.">2-window persistence</Term>
        </span>
        {streamError && <span className="ct-stream-error">Refresh error: {streamError}</span>}
      </div>
      <div className="ct-audience">
        <button type="button" className={audience === "operations" ? "ct-audience__active" : ""} onClick={() => onAudienceChange("operations")}>Operations</button>
        <button type="button" className={audience === "executive" ? "ct-audience__active" : ""} onClick={() => onAudienceChange("executive")}>Executive</button>
      </div>
    </header>
  );
}
