"use client";
import { useCallback } from "react";
import { useApi } from "@/lib/api";

/**
 * Reads the resolved PULSE.toml [modules] map from the daemon and returns a
 * predicate for filtering nav entries.
 *
 * Fails open on purpose. Until the fetch lands — and permanently if it errors,
 * or if the daemon predates /api/config/modules — every entry stays visible.
 * A dashboard briefly showing a tab it will hide a moment later is a much
 * smaller problem than a nav that empties itself because one request failed.
 *
 * ported from public PR #1749, @elhoim
 */
export function useEnabledModules(): (item: { module?: string }) => boolean {
  const { data } = useApi<{ modules?: Record<string, boolean> } | null>("/api/config/modules");
  const modules = data?.modules ?? null;

  // Stable identity while `modules` is unchanged, so callers can memoise the
  // filtered list on this predicate instead of rebuilding it every render.
  return useCallback(
    (item: { module?: string }) => {
      if (!modules || !item.module) return true;
      return modules[item.module] !== false;
    },
    [modules],
  );
}
