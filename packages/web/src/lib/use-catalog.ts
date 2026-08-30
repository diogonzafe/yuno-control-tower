"use client";

import { useEffect, useState } from "react";
import type { Catalog } from "@control-tower/app";
import { FIXTURE_CATALOG } from "./fixtures";

export function useCatalog(): { catalog: Catalog | null; failed: boolean } {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_USE_FIXTURES === "true") {
      setCatalog(FIXTURE_CATALOG);
      return;
    }

    let cancelled = false;
    fetch("/api/catalog")
      .then((response) => response.json())
      .then((data: Catalog) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { catalog, failed };
}
