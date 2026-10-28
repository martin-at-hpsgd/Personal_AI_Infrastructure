import { USAGE_HARD_EXPIRY } from "./UsageView";
import { object, string, type State } from "../State";
import { readJson } from "../Cache";

/** The Codex usage cache's TTL; a reading older than twice this is dimmed and badged. */
export const CODEX_USAGE_TTL = 300;

export interface CodexWindow { label: string; pct: string; reset: string }
export interface CodexView {
  state: "fresh" | "absent";
  age: number;
  plan: string;
  email: string;
  limitReached: boolean;
  windows: CodexWindow[];
}

const text = (v: unknown, fallback: string): string => (typeof v === "number" ? String(v) : typeof v === "string" && v !== "" ? v : fallback);

/** Codex plan windows from codex-usage.json: fresh within the six-hour hard expiry, else absent. */
export function codexView(state: State): CodexView {
  const absent: CodexView = { state: "absent", age: 0, plan: "", email: "", limitReached: false, windows: [] };
  const path = state.env.LIFEOS_CODEX_USAGE_CACHE || state.cache.path("codex-usage.json");
  const raw = readJson(path);
  if (raw === null) return absent;
  const cache = object(raw);
  const fetched = typeof cache.fetched_at === "number" && Number.isFinite(cache.fetched_at) ? Math.trunc(cache.fetched_at) : 0;
  let age = USAGE_HARD_EXPIRY;
  if (fetched > 0) age = Math.max(0, state.now - fetched);
  if (age >= USAGE_HARD_EXPIRY) return absent;
  const plan = string(cache.plan).toUpperCase();
  const windows = (Array.isArray(cache.windows) ? cache.windows : []).slice(0, 2).map(object);
  return {
    state: "fresh", age,
    plan: plan === "PROLITE" ? "PRO" : plan,
    email: string(cache.email),
    limitReached: cache.limit_reached === true,
    windows: windows.map(w => ({ label: string(w.label), pct: text(w.pct, "0"), reset: text(w.reset_at, "0") })),
  };
}
