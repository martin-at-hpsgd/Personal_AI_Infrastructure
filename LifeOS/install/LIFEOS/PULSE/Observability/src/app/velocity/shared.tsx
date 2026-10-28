"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pieces every Velocity view shares: the range list, the month-day formatters, the range kept in
 * `?range=` (clean path URLs, never a hash), and the three-entry view switch.
 */

export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const fmt = (day: string) => `${MONTHS[+day.slice(5, 7) - 1]} ${+day.slice(8, 10)}`;
/** Range label: month-day when both ends fall in the current year, else month-day-year on both ends. */
export const fmtRange = (from: string, to: string) => { const y = String(new Date().getFullYear()); const sameYear = from.slice(0, 4) === y && to.slice(0, 4) === y; const f = (d: string) => sameYear ? fmt(d) : `${fmt(d)}, ${d.slice(0, 4)}`; return `${f(from)} – ${f(to)}`; };
export const RANGES = [["7d", "7 days"], ["14d", "14 days"], ["30d", "30 days"], ["90d", "90 days"], ["ytd", "Year to date"], ["2y", "2 years"], ["3y", "3 years"], ["4y", "4 years"], ["5y", "5 years"], ["10y", "10 years"], ["all", "All"]] as const;
export const DEFAULT_RANGE = "30d";

export type View = "deeds" | "commits" | "prs";
/** Deeds first: it is the view the bare `/velocity` path opens. */
export const VIEWS: { id: View; label: string; href: string }[] = [
  { id: "deeds", label: "Deeds", href: "/velocity" },
  { id: "commits", label: "Commits", href: "/velocity/commits" },
  { id: "prs", label: "PRs", href: "/velocity/prs" },
];

/** The range named in the URL, or the default. Safe on the server (returns the default). */
export function readRange(): string {
  if (typeof window === "undefined") return DEFAULT_RANGE;
  try {
    const r = new URLSearchParams(window.location.search).get("range");
    return r && RANGES.some(([id]) => id === r) ? r : DEFAULT_RANGE;
  } catch { return DEFAULT_RANGE; }
}

/**
 * Range state read from `?range=` on mount and written back on every change, so a reload and the view switch keep it.
 * The first render always uses the default (it is what the static export was built with); `ready` flips once the URL has been read,
 * and every fetch waits for it so no view queries a range it is about to replace.
 */
export function useRange(): [string, (r: string) => void, boolean] {
  const [range, setRange] = useState<string>(DEFAULT_RANGE);
  const [ready, setReady] = useState(false);
  useEffect(() => { setRange(readRange()); setReady(true); }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      const u = new URL(window.location.href);
      if (range === DEFAULT_RANGE) u.searchParams.delete("range"); else u.searchParams.set("range", range);
      const next = u.pathname + u.search;
      if (next !== window.location.pathname + window.location.search) window.history.replaceState(window.history.state, "", next);
    } catch { /* the URL is a convenience, the state still holds */ }
  }, [range, ready]);
  return [range, setRange, ready];
}

/** Three entries, one per view, each carrying the selected range to the next view. */
export function ViewSwitch({ view, range }: { view: View; range: string }) {
  const router = useRouter();
  const go = (href: string) => router.push(range === DEFAULT_RANGE ? href : `${href}?range=${encodeURIComponent(range)}`);
  return (
    <div className="mt-5 inline-flex rounded-md border border-line-2 overflow-hidden text-[13px]" role="tablist" aria-label="Velocity view" data-testid="velocity-view-switch">
      {VIEWS.map((v) => (
        <button key={v.id} type="button" role="tab" aria-selected={view === v.id} data-view-id={v.id} onClick={() => view !== v.id && go(v.href)}
          className={`px-4 py-1.5 font-medium ${view === v.id ? "bg-surface-2 text-ink-1" : "text-ink-3 hover:text-ink-1"}`}>{v.label}</button>
      ))}
    </div>
  );
}

/** The one range bar the Deeds and PRs views share; Commits keeps its own filter bar and uses the same RANGES. */
export function RangeBar({ range, onChange, label }: { range: string; onChange: (r: string) => void; label?: string }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]" data-testid="velocity-filters">
      <div className="inline-flex rounded-md border border-line-2 overflow-hidden">
        {RANGES.map(([id, l]) => <button key={id} onClick={() => onChange(id)} data-range-id={id} className={`px-2.5 py-1 ${range === id ? "bg-surface-2 text-ink-1" : "text-ink-3 hover:text-ink-1"}`}>{l}</button>)}
      </div>
      {label && <span className="ml-auto text-ink-3 mono" data-testid="velocity-range">{label}</span>}
    </div>
  );
}
