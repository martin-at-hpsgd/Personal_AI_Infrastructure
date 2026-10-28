/**
 * Vigil F18 world watch (ISC-468..472, 478, 481): the principal's watchlist and the code-only matcher. A `surface` or `watch-*`
 * event whose title, summary or labels name a watchlist term is tagged with the group and term and raised one severity step,
 * never above high. No model runs here: Surface already rated the item once, and the editor's one call per tick stays the only
 * judgment. The watchlist is USER data (`LIFEOS/USER/VIGIL/watchlist.json`); it holds themes and names, never amounts.
 * @version 0.1.0
 */
import { existsSync, readFileSync } from "node:fs";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";
import type { VigilEvent } from "./Schema";
import { appendJson, statePath } from "./State";

export type Watchlist = { groups: Record<string, string[]> };
export type WatchMatch = { group: string; term: string };
export class WatchlistError extends Error { constructor(message: string) { super(message); this.name = "WatchlistError"; } }

/** VIGIL_WATCHLIST moves it (tests, sandboxes). */
export const watchlistPath = (): string => process.env.VIGIL_WATCHLIST || lifeosPath("USER", "VIGIL", "watchlist.json");
/** A currency sign before a number, a price with cents, a percentage or a share count, a thousands-grouped number, or a k/m/b amount: an amount, never a theme or a name. */
const AMOUNT = /[$€£¥]\s?\d|\b\d[\d,]*\.\d{2}\b|\b\d+(\.\d+)?\s?(%|percent\b|shares?\b|units?\b)|\b\d{1,3}(,\d{3})+\b|\b\d+(\.\d+)?\s?[kmb]\b/i;
/** A market index keeps its number ("Nasdaq 100", "S&P 500"); a short version keeps its own ("Web 3.0"). Any other standalone number in a term is a count or an id. */
const INDEX = /^(nasdaq|s&p|russell|dow|ftse|nikkei|dax|stoxx|euro stoxx|hang seng|cac)\s?-?\s?\d+$/i;
const VERSION = /^\d\.\d$/;
function carriesAmount(term: string): boolean {
  if (AMOUNT.test(term)) return true;
  if (INDEX.test(term.trim())) return false;
  return term.split(/\s+/).some((token) => /^\d+([.,]\d+)?$/.test(token) && !VERSION.test(token));
}

/** ISC-472: the watchlist's shape, and no value that carries an amount. Throws WatchlistError naming the first fault. */
export function validateWatchlist(raw: unknown): Watchlist {
  const groups = (raw as { groups?: unknown })?.groups;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new WatchlistError("watchlist needs a `groups` object of group name to term list");
  const out: Record<string, string[]> = {};
  for (const [group, terms] of Object.entries(groups as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(group)) throw new WatchlistError(`group name "${group}" must be lowercase letters, digits and hyphens`);
    if (!Array.isArray(terms) || terms.some((t) => typeof t !== "string" || t.trim().length < 2)) throw new WatchlistError(`group "${group}" must list terms of two or more characters`);
    for (const t of terms as string[]) if (carriesAmount(t)) throw new WatchlistError(`group "${group}" term "${t}" looks like an amount; the watchlist holds themes and names only`);
    out[group] = [...new Set((terms as string[]).map((t) => t.trim()))];
  }
  return { groups: out };
}

/** Read fresh on every call (ISC-468), so a term added between ticks matches on the next. No file means the feature is off: null. */
export function loadWatchlist(path: string = watchlistPath()): Watchlist | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new WatchlistError(`watchlist at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return validateWatchlist(raw);
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Feeds and the story feed's own decode leave apostrophes as curly quotes or HTML entities; both sides are folded to plain ones before matching (checker, 2026-10-22). */
export function fold(s: string): string {
  return s.replace(/&(apos|#0*39|#x0*27|rsquo|lsquo);/gi, "'").replace(/[‘’ʼ]/g, "'").replace(/&(quot|ldquo|rdquo);|[“”]/gi, '"').replace(/&amp;/gi, "&");
}
const compiled = new Map<string, RegExp>();
const termRe = (term: string): RegExp => { let re = compiled.get(term); if (!re) { re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(fold(term))}(?![\\p{L}\\p{N}])`, "iu"); compiled.set(term, re); } return re; };

/** ISC-469: the first watchlist term the text names, whole words only and case-insensitive, longest term first so "Acmecorp AI" wins over "AI". */
export function matchText(text: string, list: Watchlist): WatchMatch | null {
  const pairs = Object.entries(list.groups).flatMap(([group, terms]) => terms.map((term) => ({ group, term }))).sort((a, b) => b.term.length - a.term.length);
  const folded = fold(text);
  for (const p of pairs) if (termRe(p.term).test(folded)) return p;
  return null;
}

/** Sources whose events are matched: the story feed's news stream and every watch (ISC-469, ISC-478). */
export const inScope = (source: string): boolean => source === "surface" || source.startsWith("watch-");
const RANK = ["info", "low", "medium", "high", "critical"] as const;
/** ISC-470: one step up, never above high; high and critical are left as they are. */
export function raise(severity: VigilEvent["severity"]): VigilEvent["severity"] { const i = RANK.indexOf(severity); return i >= RANK.indexOf("high") ? severity : RANK[i + 1]!; }

export type MatchRow = { ts: string; event_id: string; source: string; group: string; term: string; from: VigilEvent["severity"]; to: VigilEvent["severity"]; burst: boolean; title: string };

/**
 * Tag and raise every in-scope event that names a watchlist term; everything else passes through untouched. Pure apart from the
 * returned rows: the tick records them (ISC-481). An event already tagged is never raised twice.
 */
export function applyWatchlist(events: VigilEvent[], list: Watchlist | null, now: Date = new Date()): { events: VigilEvent[]; rows: MatchRow[] } {
  if (!list) return { events, rows: [] };
  const rows: MatchRow[] = [];
  const out = events.map((e) => {
    if (!inScope(e.source) || typeof e.meta?.watch_group === "string") return e;
    const labels = typeof e.meta?.labels === "string" ? e.meta.labels : "";
    const hit = matchText(`${e.title}\n${e.summary}\n${labels}`, list);
    if (!hit) return e;
    const to = raise(e.severity);
    rows.push({ ts: now.toISOString(), event_id: e.id, source: e.source, group: hit.group, term: hit.term, from: e.severity, to, burst: e.meta?.burst === true, title: e.title.slice(0, 140) });
    return { ...e, severity: to, meta: { ...(e.meta ?? {}), watch_group: hit.group, watch_term: hit.term, watch_from: e.severity } };
  });
  invariant(out.length === events.length, "watchlist matching keeps every event");
  return { events: out, rows };
}

export const MATCHES_FILE = "world-watch.jsonl";
/** Append the tick's match rows to Vigil state (ISC-481 reads them back). */
export function recordMatches(rows: MatchRow[]): void {
  for (const row of rows) { invariant(row.event_id.length > 0 && row.group.length > 0 && row.term.length > 0, "a match row names its event, group and term"); appendJson(statePath(MATCHES_FILE), row); }
}

const jsonl = <T>(path: string): T[] => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } }); } catch { return []; } };
export type GroupReport = { group: string; matches: number; bursts: number; texts: number; good: number; noise: number; missed: number };

/**
 * ISC-481: per watchlist group over the last `days`, how many events matched, how many were bursts, how many reached the phone
 * (a Vigil `sent` notification for the matched event), and {{PRINCIPAL_NAME}}'s labels on them. Every group in the watchlist is listed, quiet ones at zero.
 */
export function worldWatchReport(days: number, now: Date = new Date(), deps: { matches?: MatchRow[]; notices?: VigilEvent[]; feedback?: Array<{ event_id?: string; label?: string }>; list?: Watchlist | null } = {}): GroupReport[] {
  const cutoff = now.getTime() - days * 86_400_000;
  // One row per event: a tick that failed after recording re-reads its events and records them again.
  const matches = [...new Map((deps.matches ?? jsonl<MatchRow>(statePath(MATCHES_FILE))).filter((m) => Date.parse(m.ts) >= cutoff).map((m) => [m.event_id, m] as const)).values()];
  const notices = deps.notices ?? jsonl<VigilEvent>(statePath("outbox.jsonl"));
  const sent = new Set(notices.filter((e) => e.source === "vigil" && e.kind === "notification" && e.meta?.decision === "sent" && e.ref).map((e) => e.ref!));
  const feedback = deps.feedback ?? jsonl<{ event_id?: string; label?: string }>(lifeosPath("USER", "VIGIL", "editor-feedback.jsonl"));
  const labelOf = new Map(feedback.filter((f) => f.event_id && f.label).map((f) => [f.event_id!, f.label!] as const));
  const list = deps.list === undefined ? (() => { try { return loadWatchlist(); } catch { return null; } })() : deps.list;
  const groups = new Set([...Object.keys(list?.groups ?? {}), ...matches.map((m) => m.group)]);
  return [...groups].sort().map((group) => {
    const mine = matches.filter((m) => m.group === group);
    const count = (label: string) => mine.filter((m) => labelOf.get(m.event_id) === label).length;
    return { group, matches: mine.length, bursts: mine.filter((m) => m.burst).length, texts: mine.filter((m) => sent.has(m.event_id)).length, good: count("good"), noise: count("noise"), missed: count("missed") };
  });
}

export function worldWatchReportText(rows: GroupReport[], days: number): string {
  if (!rows.length) return `World watch, last ${days} days: no watchlist groups (add ${watchlistPath()}).`;
  return [`World watch, last ${days} days`, ...rows.map((r) => `${r.group.padEnd(14)} matches ${r.matches}  bursts ${r.bursts}  texts ${r.texts}  good ${r.good}  noise ${r.noise}  missed ${r.missed}`)].join("\n");
}
