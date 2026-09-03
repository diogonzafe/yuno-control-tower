"use client";

import { useEffect, useRef, useState } from "react";
import type { IncidentRow, PortfolioPoint, ProviderMinutePoint } from "@control-tower/app";
import type { PendingSignal } from "@control-tower/contracts";
import { FIXTURE_SNAPSHOT } from "./fixtures";

export type StreamSnapshot = {
  incidents: IncidentRow[];
  providerSeries: ProviderMinutePoint[];
  portfolioSeries: PortfolioPoint[];
  pendingSignals: PendingSignal[];
  generatedAt: string;
};

export function useControlTowerStream() {
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_USE_FIXTURES === "true") {
      // Delayed so the loading state is actually visible while developing it.
      const timeout = setTimeout(() => {
        setSnapshot(FIXTURE_SNAPSHOT);
        setConnected(true);
      }, 600);
      return () => clearTimeout(timeout);
    }

    let source: EventSource | undefined;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource("/api/stream");
      source.onopen = () => setConnected(true);
      source.onmessage = (event) => {
        try {
          setSnapshot(JSON.parse(event.data) as StreamSnapshot);
          setStreamError(null);
        } catch {
          // Malformed frame: skip it, the next tick will self-correct.
        }
      };
      source.onerror = (event) => {
        if (event instanceof MessageEvent) {
          // A named `event: error` frame from the server (stream/route.ts) —
          // the connection is fine, one tick's query failed. No reconnect;
          // the next 4s tick retries on its own.
          let message = "unknown error";
          try {
            message = (JSON.parse(event.data as string) as { message?: string }).message ?? message;
          } catch {
            // Malformed error frame: keep the generic message.
          }
          setStreamError(message);
          return;
        }
        setConnected(false);
        source?.close();
        retryRef.current = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      cancelled = true;
      source?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, []);

  return { snapshot, connected, streamError };
}
