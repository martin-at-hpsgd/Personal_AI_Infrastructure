"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { AlgorithmState, AlgorithmApiResponse, RatingPulse } from "@/types/algorithm";
import { useApi } from "@/lib/api";

// 2026-05-24 (realtime-phase-tracking): SSE-first with polling fallback.
//
//   - When the SSE channel (/api/algorithm/stream) is connected, state updates
//     arrive within ~100ms of work.json being written. Polling drops to the
//     STALE_POLL_INTERVAL safety net (30s).
//   - When SSE is unavailable (server returns 503 with LIFEOS_NO_SSE=1, or the
//     connection fails repeatedly), the hook falls back to the legacy 2s
//     polling cadence. Behavior is identical to pre-realtime-tracking.
//
// Single source of truth for parsed AlgorithmState — the SSE payload shape
// is byte-for-byte identical to `GET /api/algorithm` (extracted from the
// same `buildAlgorithmStatePayload()`).
const FAST_POLL_INTERVAL = 2000;      // fallback when SSE is unavailable
const STALE_POLL_INTERVAL = 30_000;   // safety net when SSE is connected
const SSE_RECONNECT_RETRIES = 3;      // give up SSE after N consecutive failures

/** Normalize API response to ensure new fields have defaults */
function normalizeState(state: AlgorithmState): AlgorithmState {
  return {
    ...state,
    tracked: state.tracked ?? (state.criteria?.length > 0),
    climb: state.climb ?? [],
    ratings: state.ratings ?? [],
  };
}

function applyPayload(
  data: AlgorithmApiResponse,
  setAlgorithmStates: (s: AlgorithmState[]) => void,
  setPulseStrip: (p: RatingPulse[]) => void,
): void {
  if (data.algorithms && Array.isArray(data.algorithms)) {
    setAlgorithmStates(data.algorithms.map(normalizeState));
  } else if (data.active !== false && (data as unknown as AlgorithmState).sessionId) {
    setAlgorithmStates([normalizeState(data as unknown as AlgorithmState)]);
  } else {
    setAlgorithmStates([]);
  }
  setPulseStrip(data.pulseStrip ?? []);
}

export function useAlgorithmState() {
  const [algorithmStates, setAlgorithmStates] = useState<AlgorithmState[]>([]);
  const [pulseStrip, setPulseStrip] = useState<RatingPulse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Poll cadence: fast until SSE is confirmed, then the slow safety net; fast again if SSE gives up.
  const [pollMs, setPollMs] = useState(FAST_POLL_INTERVAL);
  const sseRef = useRef<EventSource | null>(null);
  const sseConnectedRef = useRef(false);
  const sseFailureCountRef = useRef(0);

  const query = useApi<AlgorithmApiResponse>("/api/algorithm", { refetchInterval: pollMs });

  // Per-update side effects: apply each successful fetch, surface each failed one.
  useEffect(() => {
    if (query.data === undefined) return;
    applyPayload(query.data, setAlgorithmStates, setPulseStrip);
    setError(null);
    setIsLoading(false);
  }, [query.data, query.dataUpdatedAt]);

  useEffect(() => {
    if (!query.error) return;
    setError(query.error instanceof Error ? query.error.message : "Failed to fetch algorithm state");
    setIsLoading(false);
  }, [query.error, query.errorUpdatedAt]);

  // SSE wiring — try once; on persistent failure, fall back to polling.
  const connectSSE = useCallback(() => {
    if (typeof window === "undefined") return;
    if (typeof EventSource === "undefined") return;
    if (sseRef.current) return;

    try {
      const es = new EventSource("/api/algorithm/stream");
      sseRef.current = es;

      es.addEventListener("algorithm", (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as AlgorithmApiResponse;
          applyPayload(data, setAlgorithmStates, setPulseStrip);
          setError(null);
          setIsLoading(false);
          if (!sseConnectedRef.current) {
            sseConnectedRef.current = true;
            sseFailureCountRef.current = 0;
            // Once SSE is confirmed, polling drops to the slow safety net.
            setPollMs(STALE_POLL_INTERVAL);
          }
        } catch {
          // bad frame; ignore
        }
      });

      es.onerror = () => {
        // EventSource auto-reconnects on transient errors. Only give up after
        // SSE_RECONNECT_RETRIES consecutive non-open events.
        sseFailureCountRef.current += 1;
        if (sseFailureCountRef.current >= SSE_RECONNECT_RETRIES) {
          try { es.close(); } catch {}
          sseRef.current = null;
          sseConnectedRef.current = false;
          setPollMs(FAST_POLL_INTERVAL);
        }
      };
    } catch {
      // EventSource construction failed; stay on polling
      sseRef.current = null;
    }
  }, []);

  const disconnectSSE = useCallback(() => {
    if (sseRef.current) {
      try { sseRef.current.close(); } catch {}
      sseRef.current = null;
    }
    sseConnectedRef.current = false;
    sseFailureCountRef.current = 0;
  }, []);

  // The stream closes while the tab is hidden and reopens on return. Data polling pauses on its own
  // (the query client never polls a hidden tab); this handler only manages the EventSource.
  useEffect(() => {
    connectSSE();

    const handleVisibility = () => {
      if (document.hidden) {
        disconnectSSE();
        setPollMs(FAST_POLL_INTERVAL);
      } else {
        connectSSE();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disconnectSSE();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connectSSE, disconnectSSE]);

  // Backward-compatible: also expose first state as algorithmState
  const algorithmState = algorithmStates.length > 0 ? algorithmStates[0] : null;

  return { algorithmState, algorithmStates, pulseStrip, isLoading, error };
}
