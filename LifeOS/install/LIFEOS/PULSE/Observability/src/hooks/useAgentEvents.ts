"use client";

import { useState, useEffect, useRef } from "react";
import { useApi } from "@/lib/api";

// ─── Full HookEvent (matches Observability server payload) ───

export interface HookEvent {
  id: number;
  source_app: string;
  session_id: string;
  hook_event_type: string;
  payload: Record<string, any>;
  summary?: string;
  timestamp?: number;
  model_name?: string;
  agent_name?: string;
}

// Simplified event (backward-compat)
export interface AgentEvent {
  id: number;
  source_app: string;
  session_id: string;
  hook_event_type: string;
  summary?: string;
  timestamp?: number;
  agent_name?: string;
}

export interface BackgroundTask {
  taskId: string;
  sessionId: string;
  agentId: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  lastActivity: number;
  description: string;
  outputPreview: string;
  eventCount: number;
  taskType: "bash" | "agent" | "unknown";
}

// ─── Hook (HTTP polling only — no WebSocket) ───

export function useAgentEvents(maxEvents = 500) {
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const eventIdRef = useRef(0);
  const seenIdsRef = useRef(new Set<string>());
  // Polls every 3 s; the query pauses while the browser tab is hidden.
  const agents = useApi<{ events: Array<Record<string, any>> }>("/api/agents", { refetchInterval: 3_000, retry: false });

  useEffect(() => {
    if (agents.errorUpdatedAt) setIsConnected(false);
  }, [agents.errorUpdatedAt]);

  useEffect(() => {
    const data = agents.data;
    if (!data?.events?.length) return;
    const newEvents: HookEvent[] = [];
    for (const e of data.events) {
      const key = `${e.timestamp}|${e.session_id}|${e.hook_event_type}|${e.source_app}`;
      if (!seenIdsRef.current.has(key)) {
        seenIdsRef.current.add(key);
        newEvents.push({
          ...e,
          id: eventIdRef.current++,
          payload: e.payload || {},
        } as HookEvent);
      }
    }

    // Trim seen set
    if (seenIdsRef.current.size > maxEvents * 2) {
      seenIdsRef.current = new Set(
        data.events.map((e: Record<string, any>) => `${e.timestamp}|${e.session_id}|${e.hook_event_type}|${e.source_app}`)
      );
    }

    if (newEvents.length > 0) {
      setEvents((prev) => [...prev, ...newEvents].slice(-maxEvents));
    }
    setIsConnected(true);
  }, [agents.data, agents.dataUpdatedAt, maxEvents]);

  return { events, tasks, isConnected };
}
