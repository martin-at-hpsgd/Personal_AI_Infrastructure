"use client";

import { useEffect, useState } from "react";
import { useApi } from "./api";
import { principalTz, setPrincipalTz } from "./principal-tz";

/**
 * Loads the principal's current zone (GET /api/config/timezone, which follows the location service) into
 * src/lib/principal-tz.ts for every formatter in src/lib/time.ts, and re-renders the app once when the zone
 * differs from the one it drew with (Pulse ISA F7). Rechecked every 10 minutes, so a flight changes the clocks.
 */
export function PrincipalTzSync({ children }: { children: React.ReactNode }) {
  const tz = useApi<{ timezone: string }>("/api/config/timezone", { staleTime: 10 * 60_000, refetchInterval: 10 * 60_000 });
  const [drawnWith, setDrawnWith] = useState(principalTz());
  useEffect(() => {
    if (!tz.data?.timezone) return;
    setPrincipalTz(tz.data.timezone);
    if (principalTz() !== drawnWith) setDrawnWith(principalTz());
  }, [tz.data, drawnWith]);
  // Keyed on the zone: a zone change remounts the tree once so every clock redraws in the new zone.
  return <div key={drawnWith} className="contents">{children}</div>;
}
