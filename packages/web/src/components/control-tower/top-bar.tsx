"use client";

import type { Audience } from "../../lib/narrative";

export function TopBar({
  loading,
  connected,
  streamError,
  openCount,
  audience,
  onAudienceChange,
}: {
  loading: boolean;
  connected: boolean;
  streamError: string | null;
  openCount: number;
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
          <span>{openCount} open</span>
        </div>
        <span className="ct-meta">rollup_minute · Wilson 95% CI · 2-window persistence</span>
        {streamError && <span className="ct-stream-error">Refresh error: {streamError}</span>}
      </div>
      <div className="ct-audience">
        <button type="button" className={audience === "operations" ? "ct-audience__active" : ""} onClick={() => onAudienceChange("operations")}>Operations</button>
        <button type="button" className={audience === "executive" ? "ct-audience__active" : ""} onClick={() => onAudienceChange("executive")}>Executive</button>
      </div>
    </header>
  );
}
