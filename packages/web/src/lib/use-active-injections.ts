"use client";

import { useEffect, useState } from "react";

export type ActiveIncident = { id: string; dimensions: Record<string, string>; conversionMultiplier: number; startsAt: string };

// The console (which mutates these) and the dashboard's live chart (which
// only reads startsAt for its injection markers) now live on separate pages,
// so each needs its own poll — there is no shared React tree to lift state
// into anymore.
export function useActiveInjections(pollMs = 5000) {
  const [active, setActive] = useState<ActiveIncident[]>([]);

  const refresh = () => {
    fetch("/api/inject")
      .then((response) => response.json())
      .then((data: ActiveIncident[]) => setActive(data))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollMs);
    return () => clearInterval(interval);
  }, [pollMs]);

  return { active, refresh };
}
