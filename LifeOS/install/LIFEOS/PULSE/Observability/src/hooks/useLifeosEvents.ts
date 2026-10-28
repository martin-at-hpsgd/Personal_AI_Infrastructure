"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useApi } from "@/lib/api";

// ─── Types ───

export interface LifeosEvent {
  timestamp: string;
  session_id: string;
  source: string;
  type: string;
  [key: string]: unknown;
}

// ─── Constants ───

const MAX_BUFFER = 200;
const POLL_INTERVAL = 3_000;

// ─── Hook ───

export function useLifeosEvents() {
  const [events, setEvents] = useState<LifeosEvent[]>([]);
  const lastHashRef = useRef("");
  // Polls every POLL_INTERVAL; the query pauses while the browser tab is hidden. Errors are expected when data is unavailable.
  const recent = useApi<LifeosEvent[] | { events: LifeosEvent[] }>("/api/events/recent", { refetchInterval: POLL_INTERVAL, retry: false });

  useEffect(() => {
    const data = recent.data;
    if (!data) return;
    // Handle both {events: [...]} and flat [...] response formats
    const eventList = Array.isArray(data) ? data : data.events;
    if (eventList?.length) setEvents(eventList.slice(-MAX_BUFFER));
  }, [recent.data, recent.dataUpdatedAt]);

  // ─── Filtering ───

  const filteredEvents = useCallback(
    (prefix: string): LifeosEvent[] => {
      if (!prefix) return events;
      const cleanPrefix = prefix.endsWith(".*")
        ? prefix.slice(0, -2)
        : prefix.endsWith("*")
        ? prefix.slice(0, -1)
        : prefix;

      return events.filter((e) => {
        if (cleanPrefix !== prefix) {
          return e.type.startsWith(cleanPrefix);
        }
        return e.type === prefix;
      });
    },
    [events]
  );

  // ─── Clear ───

  const clearEvents = useCallback(() => {
    setEvents([]);
    lastHashRef.current = "";
  }, []);

  return { events, filteredEvents, clearEvents };
}
