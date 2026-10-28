/**
 * Velocity Pulse module — the query engine over the shipping-velocity record cache.
 *
 * Routes:
 *   GET  /api/velocity/meta                     → repos, categories, models timeline, tags, authors, generated
 *   GET  /api/velocity/query?range=30d&bucket=week&group=project&project=&category=&author=&model=&cls=
 *                                               → series, table, totals + previous-window deltas, rhythm,
 *                                                 records, movers, stalls, models, events
 *   GET  /api/velocity/presets                  → compare presets (model switches, feature tags)
 *   GET  /api/velocity/deeds?range=30d         → caps, fixes and tends as three separate numbers, weekly trend, per-repo, every cap in range
 *   GET  /api/velocity/prs?range=30d           → merged pull requests, weekly and per repo, over the same repos
 *   POST /api/velocity/refresh                  → re-run LIFEOS/TOOLS/ShippingVelocity.ts (202)
 *
 * Holds ZERO truth and never runs git on GET: it reads MEMORY/STATE/velocity/ written by the
 * collector (nightly com.lifeos.velocity, or the refresh route) and reloads when meta.json's
 * mtime moves. No file paths, no secrets in any payload beyond the repo tilde paths in meta.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { principalTimezone } from "../../TOOLS/lib/Timezone";

const MODULE_NAME = "velocity";
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const LIFEOS_DIR = join(CLAUDE_DIR, "LIFEOS");
const TOOL = join(LIFEOS_DIR, "TOOLS", "ShippingVelocity.ts");
const DEFAULT_STATE_DIR = join(LIFEOS_DIR, "MEMORY", "STATE", "velocity");
/** VELOCITY_STATE_DIR points the module at a fixture directory (tests); unset in production. */
const stateDir = () => process.env.VELOCITY_STATE_DIR || DEFAULT_STATE_DIR;
const metaPath = () => join(stateDir(), "meta.json");
const REFRESH_TIMEOUT_MS = 10 * 60_000;

type FileClass = "code" | "docs" | "data" | "other";
interface Rec { h: string; t: number; day: string; hr: number; dow: number; a: string; s: string; ins: number; del: number; files: number; fc: Record<FileClass, [number, number, number]>; cls: string; tags: string[]; m?: string; mv?: string }
interface MetaRepo { id: string; path: string; name: string; category: string; head: string; commits: number; lastDay: string | null; tracked?: boolean; retired?: boolean }
interface Meta {
  generated: string; timezone: string; since: string; authors: string[]; authorsLabel: string | null; excludeSubjects: string[];
  categories: string[]; repos: MetaRepo[]; models: { at: number; raw: string; label: string }[];
  /** Every lane's pin history (carrier, advisor, each cross-vendor lane) — config inference, never commit attribution. */
  lanes?: { lane: string; vendor: string; at: number; raw: string; label: string }[];
  /** Agent dispatches with their resolved model, per day — evidence of when each vendor actually ran. */
  dispatches?: { day: string; agent: string; model: string; vendor: string; label: string; n: number; secs: number }[];
  tags: { repo: string; tag: string; day: string; kind: string }[]; events: { date: string; label: string }[];
  stallDays: number; moverFloor: number; stallMinCommits?: number; collect: Record<string, number>;
}
/** `model` is the trailer-named model when the commit carries one (evidence), else the carrier pinned at commit time (inference); `ev` says which. */
interface Row extends Rec { repo: string; project: string; category: string; model: string; ev: boolean }

const state = { running: false, refreshing: false, lastRefreshError: null as string | null, loadedAt: 0, metaMtime: 0, loadedDir: "", meta: null as Meta | null, rows: [] as Row[] };

export function start() { state.running = true; }
export function health() { return { module: MODULE_NAME, running: state.running, state_present: existsSync(metaPath()), rows: state.rows.length }; }

// ---------- load ----------

function load(): boolean {
  if (!existsSync(metaPath())) return false;
  const mtime = statSync(metaPath()).mtimeMs;
  if (state.meta && mtime === state.metaMtime && state.loadedDir === stateDir()) return true;
  const meta: Meta = JSON.parse(readFileSync(metaPath(), "utf-8"));
  const authors = new Set(meta.authors);
  const excl = meta.excludeSubjects.map((s) => new RegExp(s));
  const switches = [...meta.models].sort((a, b) => a.at - b.at);
  const modelAt = (t: number): string => { let l = "unspecified"; for (const s of switches) { if (s.at <= t) l = s.label; else break; } return l; };
  const rows: Row[] = [];
  const reposDir = join(stateDir(), "repos");
  const byId = new Map(meta.repos.map((r) => [r.id, r]));
  for (const f of existsSync(reposDir) ? readdirSync(reposDir) : []) {
    const id = f.replace(/\.json$/, ""); const mr = byId.get(id); if (!mr) continue;
    let cache: { records: Rec[] };
    try { cache = JSON.parse(readFileSync(join(reposDir, f), "utf-8")); } catch { continue; }
    for (const r of cache.records) {
      if (!authors.has(r.a) || excl.some((re) => re.test(r.s))) continue;
      rows.push({ ...r, repo: id, project: mr.name, category: mr.category, model: r.m ?? modelAt(r.t), ev: r.m !== undefined });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  state.meta = meta; state.rows = rows; state.metaMtime = mtime; state.loadedDir = stateDir(); state.loadedAt = Date.now();
  return true;
}

// ---------- dates ----------

const addDays = (day: string, n: number) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86_400_000);
const weekStart = (day: string) => { const d = new Date(day + "T12:00:00Z"); return addDays(day, -((d.getUTCDay() + 6) % 7)); };
const monthStart = (day: string) => day.slice(0, 7) + "-01";
function todayLocal(tz: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

/** Same calendar day N years away; Feb 29 clamps to Feb 28. */
export function addYears(day: string, n: number): string { const yy = +day.slice(0, 4) + n; const md = day.slice(5); return md === "02-29" ? `${yy}-02-28` : `${yy}-${md}`; }
export function parseRange(range: string | null, today: string, since: string): { from: string; to: string; prev: { from: string; to: string } | null } {
  const to = today;
  if (!range || range === "30d") return win(addDays(to, -29), to);
  const m = range.match(/^(\d+)d$/);
  if (m) return win(addDays(to, -(+m[1] - 1)), to);
  const y = range.match(/^(\d+)y$/);
  if (y) return win(addDays(addYears(to, -+y[1]), 1), to);
  if (range === "ytd") return { from: `${to.slice(0, 4)}-01-01`, to, prev: null };
  if (range === "all") return { from: since, to, prev: null };
  const c = range.match(/^(\d{4}-\d\d-\d\d),(\d{4}-\d\d-\d\d)$/);
  if (c) return win(c[1], c[2] < to ? c[2] : to);
  return win(addDays(to, -29), to);
  function win(from: string, to: string) { const len = daysBetween(from, to) + 1; return { from, to, prev: { from: addDays(from, -len), to: addDays(from, -1) } }; }
}

// ---------- query ----------

type Group = "project" | "category" | "model" | "author" | "cls" | "fileclass";
const groupKey = (r: Row, g: Group): string => g === "project" ? r.project : g === "category" ? r.category : g === "model" ? r.model : g === "author" ? r.a : g === "cls" ? r.cls : "code";

function agg(rows: Row[]) {
  const t = { commits: rows.length, ins: 0, del: 0, files: 0, code: [0, 0] as [number, number], docs: [0, 0] as [number, number], data: [0, 0] as [number, number], other: [0, 0] as [number, number], activeDays: 0 };
  const days = new Set<string>();
  for (const r of rows) { t.ins += r.ins; t.del += r.del; t.files += r.files; days.add(r.day); for (const k of ["code", "docs", "data", "other"] as FileClass[]) { t[k][0] += r.fc[k][0]; t[k][1] += r.fc[k][1]; } }
  t.activeDays = days.size;
  return t;
}

function query(params: URLSearchParams) {
  const meta = state.meta!;
  const today = todayLocal(meta.timezone);
  const { from, to, prev } = parseRange(params.get("range"), today, meta.since);
  const days = daysBetween(from, to) + 1;
  const bucket = (params.get("bucket") as "day" | "week" | "month" | null) ?? (days <= 45 ? "day" : days <= 220 ? "week" : "month");
  const group = (params.get("group") as Group | null) ?? "category";
  const f = { project: params.get("project"), category: params.get("category"), author: params.get("author"), model: params.get("model"), cls: params.get("cls") };
  const pass = (r: Row) => (!f.project || r.project === f.project) && (!f.category || r.category === f.category) && (!f.author || r.a === f.author) && (!f.model || r.model === f.model) && (!f.cls || r.cls === f.cls);
  const inRange = state.rows.filter((r) => pass(r) && r.day >= from && r.day <= to);
  const inPrev = prev ? state.rows.filter((r) => pass(r) && r.day >= prev.from && r.day <= prev.to) : [];

  // groups, capped to top 4 + Other for series (table keeps all)
  const groupTotals = new Map<string, number>();
  for (const r of inRange) groupTotals.set(groupKey(r, group), (groupTotals.get(groupKey(r, group)) ?? 0) + 1);
  const ordered = [...groupTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const seriesGroups = ordered.length > 5 ? [...ordered.slice(0, 4), "Other"] : ordered;
  const sg = (k: string) => (seriesGroups.includes(k) ? k : "Other");
  const bucketOf = (day: string) => bucket === "day" ? day : bucket === "week" ? weekStart(day) : monthStart(day);
  const seriesMap = new Map<string, { key: string; total: number; ins: number; del: number; parts: Record<string, number> }>();
  for (let d = bucket === "day" ? from : bucketOf(from); d <= to; d = bucket === "day" ? addDays(d, 1) : bucket === "week" ? addDays(d, 7) : addDays(monthStart(addDays(d, 32)), 0)) {
    seriesMap.set(d, { key: d, total: 0, ins: 0, del: 0, parts: Object.fromEntries(seriesGroups.map((g) => [g, 0])) });
  }
  for (const r of inRange) { const b = seriesMap.get(bucketOf(r.day)); if (!b) continue; b.total++; b.ins += r.ins; b.del += r.del; b.parts[sg(groupKey(r, group))]++; }
  const series = [...seriesMap.values()].map((b) => ({ ...b, partial: b.key === bucketOf(today) }));

  // table: every group, with previous-window delta
  const prevGroup = new Map<string, number>();
  for (const r of inPrev) prevGroup.set(groupKey(r, group), (prevGroup.get(groupKey(r, group)) ?? 0) + 1);
  const total = inRange.length;
  const table = ordered.map((k) => {
    const rs = inRange.filter((r) => groupKey(r, group) === k); const a = agg(rs);
    const pc = prevGroup.get(k) ?? 0;
    return { group: k, ...a, share: total ? a.commits / total : 0, prevCommits: prev ? pc : null, delta: prev ? a.commits - pc : null, lastDay: rs.length ? rs[rs.length - 1].day : null };
  });

  // rhythm
  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  const hours = Array(24).fill(0), dows = Array(7).fill(0);
  for (const r of inRange) { matrix[r.dow][r.hr]++; hours[r.hr]++; dows[r.dow]++; }

  // records + streaks (over the range)
  const perDay = new Map<string, number>(); for (const r of inRange) perDay.set(r.day, (perDay.get(r.day) ?? 0) + 1);
  let bestDay = { day: "", commits: 0 }; for (const [d, n] of perDay) if (n > bestDay.commits) bestDay = { day: d, commits: n };
  const perWeek = new Map<string, number>(); for (const [d, n] of perDay) perWeek.set(weekStart(d), (perWeek.get(weekStart(d)) ?? 0) + n);
  let bestWeek = { week: "", commits: 0 }; for (const [w, n] of perWeek) if (n > bestWeek.commits) bestWeek = { week: w, commits: n };
  let longest = 0, run = 0, cur = 0, lFrom = "", lTo = "", rFrom = "";
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if ((perDay.get(d) ?? 0) > 0) { if (run === 0) rFrom = d; run++; if (run > longest) { longest = run; lFrom = rFrom; lTo = d; } } else run = 0;
  }
  for (let d = to; d >= from; d = addDays(d, -1)) { if ((perDay.get(d) ?? 0) > 0) cur++; else if (d !== to) break; }

  // movers + stalls (by project, always)
  const cntBy = (rs: Row[]) => { const m = new Map<string, number>(); for (const r of rs) m.set(r.project, (m.get(r.project) ?? 0) + 1); return m; };
  const nowP = cntBy(inRange), prevP = cntBy(inPrev);
  const movers = prev ? [...new Set([...nowP.keys(), ...prevP.keys()])]
    .map((p) => ({ project: p, now: nowP.get(p) ?? 0, prev: prevP.get(p) ?? 0 }))
    .filter((m) => Math.max(m.now, m.prev) >= meta.moverFloor)
    .map((m) => ({ ...m, delta: m.now - m.prev, ratio: m.prev ? m.now / m.prev : null }))
    .sort((a, b) => b.delta - a.delta) : [];
  // retired projects and untracked scratch repos are not stalled work
  const stalls = meta.repos.filter((r) => r.commits > 0 && !r.retired && (r.tracked || r.commits >= (meta.stallMinCommits ?? 0)) && (!f.project || r.name === f.project) && (!f.category || r.category === f.category))
    .map((r) => ({ project: r.name, category: r.category, lastDay: r.lastDay, daysSince: r.lastDay ? daysBetween(r.lastDay, today) : null }))
    .filter((s) => s.daysSince !== null && s.daysSince >= meta.stallDays).sort((a, b) => (b.daysSince ?? 0) - (a.daysSince ?? 0));

  // models: rate while pinned, within range
  const switches = [...meta.models].sort((a, b) => a.at - b.at);
  const fromMs = Date.parse(from + "T00:00:00"), toMs = Date.parse(addDays(to, 1) + "T00:00:00");
  const windows: { label: string; from: number; to: number }[] = [];
  for (let i = 0; i < switches.length; i++) {
    const a = Math.max(switches[i].at, fromMs), b = Math.min(i + 1 < switches.length ? switches[i + 1].at : Date.now(), toMs);
    if (b > a) windows.push({ label: switches[i].label, from: a, to: b });
  }
  const modelDays = new Map<string, number>(); for (const w of windows) modelDays.set(w.label, (modelDays.get(w.label) ?? 0) + (w.to - w.from) / 86_400_000);
  for (const r of inRange) if (r.ev && !modelDays.has(r.model)) modelDays.set(r.model, 0); // trailer-attributed models with no carrier window still get a row
  const models = [...modelDays.entries()].map(([label, d]) => {
    const rs = inRange.filter((r) => r.model === label); const a = agg(rs);
    return { label, days: Math.round(d * 10) / 10, commits: a.commits, perDay: d ? a.commits / d : 0, ins: a.ins, del: a.del, linesPerDay: d ? (a.ins + a.del) / d : 0, codeLinesPerDay: d ? (a.code[0] + a.code[1]) / d : 0, windows: windows.filter((w) => w.label === label).map((w) => ({ from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() })) };
  }).sort((a, b) => b.commits - a.commits);

  // every vendor: lane pins (config) and dispatches (evidence), in range. Neither touches commit attribution.
  const allLanes = [...(meta.lanes ?? [])].sort((a, b) => a.at - b.at);
  const laneIds = [...new Set(allLanes.map((l) => l.lane))];
  const lanes = laneIds.map((lane) => {
    const pins = allLanes.filter((l) => l.lane === lane);
    const wins: { label: string; vendor: string; from: string; to: string; days: number }[] = [];
    for (let i = 0; i < pins.length; i++) {
      const a = Math.max(pins[i].at, fromMs), b = Math.min(i + 1 < pins.length ? pins[i + 1].at : Date.now(), toMs);
      if (b > a) wins.push({ label: pins[i].label, vendor: pins[i].vendor, from: new Date(a).toISOString(), to: new Date(b).toISOString(), days: Math.round(((b - a) / 86_400_000) * 10) / 10 });
    }
    const now = pins[pins.length - 1];
    return { lane, vendor: now.vendor, now: now.label, since: new Date(now.at).toISOString().slice(0, 10), windows: wins };
  }).filter((l) => l.windows.length > 0);
  const disp = (meta.dispatches ?? []).filter((d) => d.day >= from && d.day <= to);
  const vendorTotals = new Map<string, number>(); for (const d of disp) vendorTotals.set(d.vendor, (vendorTotals.get(d.vendor) ?? 0) + d.n);
  const dispatchTotal = [...vendorTotals.values()].reduce((a, b) => a + b, 0);
  const vendors = [...vendorTotals.entries()].sort((a, b) => b[1] - a[1]).map(([vendor, n]) => {
    const rows = disp.filter((d) => d.vendor === vendor);
    const byAgent = new Map<string, { agent: string; model: string; n: number; secs: number; lastDay: string }>();
    for (const d of rows) { const k = `${d.agent}|${d.label}`; const a = byAgent.get(k) ?? { agent: d.agent, model: d.label, n: 0, secs: 0, lastDay: d.day }; a.n += d.n; a.secs += d.secs; if (d.day > a.lastDay) a.lastDay = d.day; byAgent.set(k, a); }
    return { vendor, dispatches: n, share: dispatchTotal ? n / dispatchTotal : 0, secs: rows.reduce((s, d) => s + d.secs, 0), lastDay: rows.map((d) => d.day).sort().pop() ?? null, agents: [...byAgent.values()].sort((a, b) => b.n - a.n) };
  });
  const vendorNames = vendors.map((v) => v.vendor);
  const dispatchMap = new Map<string, { key: string; total: number; parts: Record<string, number> }>();
  for (const key of seriesMap.keys()) dispatchMap.set(key, { key, total: 0, parts: Object.fromEntries(vendorNames.map((v) => [v, 0])) });
  for (const d of disp) { const b = dispatchMap.get(bucketOf(d.day)); if (!b) continue; b.total += d.n; b.parts[d.vendor] += d.n; }
  const dispatchSeries = [...dispatchMap.values()].map((b) => ({ ...b, partial: b.key === bucketOf(today) }));
  const dispatchSince = (meta.dispatches ?? []).map((d) => d.day).sort()[0] ?? null;

  // events in range
  const repoName = new Map(meta.repos.map((r) => [r.id, r.name]));
  const events = [
    ...meta.tags.filter((t) => t.day >= from && t.day <= to && t.kind !== "patch" && (!f.project || repoName.get(t.repo) === f.project)).map((t) => ({ type: "tag" as const, day: t.day, label: t.tag, project: repoName.get(t.repo) ?? t.repo, kind: t.kind })),
    ...switches.filter((s) => s.at >= fromMs && s.at < toMs).map((s) => ({ type: "model" as const, day: new Date(s.at).toISOString().slice(0, 10), label: s.label, project: null, kind: "model" })),
    ...allLanes.filter((l) => l.lane !== "carrier" && l.at >= fromMs && l.at < toMs).map((l) => ({ type: "lane" as const, day: new Date(l.at).toISOString().slice(0, 10), label: `${l.lane} → ${l.label}`, project: null, kind: l.vendor })),
    ...meta.events.filter((e) => e.date >= from && e.date <= to).map((e) => ({ type: "custom" as const, day: e.date, label: e.label, project: null, kind: "custom" })),
  ].sort((a, b) => a.day.localeCompare(b.day));

  // how commits in range got their model: a trailer naming the model (evidence) or the carrier pin at commit time (inference)
  const evidence = inRange.filter((r) => r.ev).length;
  const byVendor = new Map<string, number>(); for (const r of inRange) if (r.ev && r.mv) byVendor.set(r.mv, (byVendor.get(r.mv) ?? 0) + 1);
  const attribution = { evidence, inferred: inRange.length - evidence, vendors: [...byVendor.entries()].sort((a, b) => b[1] - a[1]).map(([vendor, commits]) => ({ vendor, commits })) };

  const totals = { ...agg(inRange), perDay: total / days, days };
  const prevTotals = prev ? { ...agg(inPrev), perDay: inPrev.length / days } : null;
  const patchTags = meta.tags.filter((t) => t.day >= from && t.day <= to && (!f.project || repoName.get(t.repo) === f.project)).length;
  return {
    generated: meta.generated, today, range: { from, to, days }, prev, bucket, group, filters: f,
    groups: ordered, seriesGroups, series, table, totals, prevTotals, rhythm: { matrix, hours, dows },
    records: { bestDay, bestWeek, streak: { current: cur, longest, from: lFrom, to: lTo } },
    movers: { up: movers.filter((m) => m.delta > 0).slice(0, 6), down: movers.filter((m) => m.delta < 0).slice(-6).reverse() },
    stalls: stalls.slice(0, 12), models, lanes, vendors, dispatchSeries, dispatchSince, attribution, events, releases: patchTags,
  };
}

// ---------- deeds and prs (read from the nightly collectors' state files) ----------

interface DeedsWeek { week: string; cap: number; fix: number; tend: number }
interface DeedsCap { name: string; change: string; sha?: string; author?: string; date: string }
type DeedsEntry =
  | { repo: string; target?: string; ok: true; commits: number; judged: number; cached: number; notJudged: number; weeks: DeedsWeek[]; caps: DeedsCap[] }
  | { repo: string; target?: string; ok: false; error: { code: string; message?: string } };
interface DeedsFile { generated: string; since: string; repos: DeedsEntry[] }
interface PrsFile { generated: string; since: string; repos: { repo: string; target?: string; ok: boolean; merged?: number; weeks?: { week: string; merged: number }[]; error?: string }[] }

const fileCache = new Map<string, { mtime: number; data: unknown }>();
/** Parsed JSON state file, re-read only when its mtime moves; null when absent or unreadable. */
function readState<T>(name: string): T | null {
  const p = join(stateDir(), name);
  try {
    const mtime = statSync(p).mtimeMs; const hit = fileCache.get(p);
    if (hit && hit.mtime === mtime) return hit.data as T;
    const data = JSON.parse(readFileSync(p, "utf-8")); fileCache.set(p, { mtime, data });
    return data as T;
  } catch { return null; }
}

// ---------- repo aliases ----------
// velocity.json `repo_names` maps a local checkout path to the only name the Commits view may show for it.
// Deeds and PRs name repos by their GitHub name, so each is resolved back to its checkout and renamed the same way.

const configPath = () => process.env.VELOCITY_CONFIG || join(LIFEOS_DIR, "USER", "CONFIG", "velocity.json");
const cfgCache = new Map<string, { mtime: number; names: Record<string, string>; roots: string[] }>();
/** repo_names and the deeds checkout roots from velocity.json; empty when the file is absent or unreadable. */
function aliasConfig(): { names: Record<string, string>; roots: string[] } {
  const p = configPath();
  try {
    const mtime = statSync(p).mtimeMs; const hit = cfgCache.get(p);
    if (hit && hit.mtime === mtime) return hit;
    const c = JSON.parse(readFileSync(p, "utf-8"));
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.repo_names ?? {})) if (typeof v === "string") names[k.replace(/\/+$/, "")] = v;
    const roots: string[] = Array.isArray(c.deeds?.roots) ? c.deeds.roots.filter((r: unknown) => typeof r === "string") : [];
    const out = { mtime, names, roots };
    cfgCache.set(p, out);
    return out;
  } catch { return { names: {}, roots: [] }; }
}

/** The alias for a GitHub repo name, or the name itself. Checks the collector's recorded checkout, the Commits view's repo path, then each configured root. */
function repoAliaser(): (repo: string, target?: string) => string {
  const { names, roots } = aliasConfig();
  if (Object.keys(names).length === 0) return (repo) => repo;
  const deedsTargets = new Map<string, string>();
  for (const e of readState<DeedsFile>("deeds.json")?.repos ?? []) if (e.target) deedsTargets.set(e.repo, e.target);
  const metaPaths = new Map<string, string[]>();
  for (const r of readState<Meta>("meta.json")?.repos ?? []) { const b = r.path.replace(/\/+$/, "").split("/").pop()!; metaPaths.set(b, [...(metaPaths.get(b) ?? []), r.path]); }
  return (repo, target) => {
    const candidates = [target, deedsTargets.get(repo), ...(metaPaths.get(repo) ?? []), ...roots.map((r) => `${r.replace(/\/+$/, "")}/${repo}`)];
    for (const c of candidates) { const a = c && names[c.replace(/\/+$/, "")]; if (a) return a; }
    return repo;
  };
}

/** Range for the deeds and prs views: the same range values as /query, in the collector's timezone (meta.json when present). */
function viewRange(params: URLSearchParams, since: string) {
  const tz = (readState<Meta>("meta.json")?.timezone) || principalTimezone();
  const { from, to } = parseRange(params.get("range"), todayLocal(tz), since);
  return { from, to, days: daysBetween(from, to) + 1 };
}
/** Every Monday from the first one on or after `from` up to `to`: the weeks that belong to the range. */
function mondaysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = weekStart(from) < from ? addDays(weekStart(from), 7) : from; d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

function deedsView(params: URLSearchParams) {
  const file = readState<DeedsFile>("deeds.json");
  const range = viewRange(params, file?.since ?? "2009-01-31");
  if (!file) return { available: false, generated: null, range, totals: { cap: 0, fix: 0, tend: 0 }, coverage: { repos: 0, commits: 0, judged: 0, notJudged: 0, cached: 0 }, weeks: [], repos: [], caps: [], errors: [] };
  const mondays = mondaysIn(range.from, range.to); const inWeeks = new Set(mondays);
  const totals = { cap: 0, fix: 0, tend: 0 };
  const coverage = { repos: 0, commits: 0, judged: 0, notJudged: 0, cached: 0 };
  const byWeek = new Map(mondays.map((w) => [w, { week: w, cap: 0, fix: 0, tend: 0 }]));
  const repos: { repo: string; cap: number; fix: number; tend: number }[] = [];
  const caps: { name: string; change: string; repo: string; date: string; sha?: string }[] = [];
  const errors: { repo: string; code: string }[] = [];
  const named = repoAliaser();
  for (const e of file.repos) {
    const shown = named(e.repo, e.target);
    if (!e.ok) { errors.push({ repo: shown, code: e.error?.code ?? "unknown" }); continue; }
    coverage.repos++; coverage.commits += e.commits; coverage.judged += e.judged; coverage.notJudged += e.notJudged; coverage.cached += e.cached;
    const rt = { repo: shown, cap: 0, fix: 0, tend: 0 };
    for (const w of e.weeks) {
      if (!inWeeks.has(w.week)) continue;
      const b = byWeek.get(w.week)!;
      for (const k of ["cap", "fix", "tend"] as const) { b[k] += w[k]; rt[k] += w[k]; totals[k] += w[k]; }
    }
    const same = repos.find((x) => x.repo === shown); // two checkouts can share one alias
    if (same) for (const k of ["cap", "fix", "tend"] as const) same[k] += rt[k]; else repos.push(rt);
    for (const c of e.caps) { const d = c.date.slice(0, 10); if (d >= range.from && d <= range.to) caps.push({ name: c.name, change: c.change, repo: shown, date: d, sha: c.sha }); }
  }
  repos.sort((a, b) => b.cap - a.cap || a.repo.localeCompare(b.repo));
  caps.sort((a, b) => b.date.localeCompare(a.date) || a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  return { available: true, generated: file.generated, range, totals, coverage, weeks: [...byWeek.values()], repos, caps, errors };
}

function prsView(params: URLSearchParams) {
  const file = readState<PrsFile>("prs.json");
  const range = viewRange(params, file?.since ?? "2009-01-31");
  if (!file) return { available: false, generated: null, range, total: 0, weeks: [], repos: [] };
  const mondays = mondaysIn(range.from, range.to); const inWeeks = new Set(mondays);
  const byWeek = new Map(mondays.map((w) => [w, { week: w, merged: 0 }]));
  const repos: { repo: string; merged: number }[] = [];
  let total = 0;
  const named = repoAliaser();
  for (const r of file.repos) {
    if (!r.ok) continue;
    let m = 0;
    for (const w of r.weeks ?? []) if (inWeeks.has(w.week)) { byWeek.get(w.week)!.merged += w.merged; m += w.merged; }
    const shown = named(r.repo, r.target); const same = repos.find((x) => x.repo === shown);
    if (same) same.merged += m; else repos.push({ repo: shown, merged: m });
    total += m;
  }
  repos.sort((a, b) => b.merged - a.merged || a.repo.localeCompare(b.repo));
  return { available: true, generated: file.generated, range, total, weeks: [...byWeek.values()], repos };
}

// ---------- refresh ----------

async function refresh(): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true; state.lastRefreshError = null;
  try {
    const proc = Bun.spawn(["bun", TOOL], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" } });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, REFRESH_TIMEOUT_MS);
    const [, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) state.lastRefreshError = err.trim().slice(0, 500) || `exit ${code}`;
  } catch (e) { state.lastRefreshError = String(e); } finally { state.refreshing = false; }
}

// ---------- routes ----------

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/velocity")) return null;
  if (pathname === "/api/velocity/refresh" && req.method === "POST") {
    refresh().catch((e) => console.log(`[${MODULE_NAME}] refresh: ${e}`));
    return Response.json({ refreshing: true }, { status: 202 });
  }
  const url = new URL(req.url);
  if (pathname === "/api/velocity/deeds") return Response.json(deedsView(url.searchParams));
  if (pathname === "/api/velocity/prs") return Response.json(prsView(url.searchParams));
  if (!load()) return Response.json({ available: false, refreshing: state.refreshing, error: state.lastRefreshError ?? "run bun LIFEOS/TOOLS/ShippingVelocity.ts once, or POST /api/velocity/refresh" });
  const meta = state.meta!;
  if (pathname === "/api/velocity/meta" || pathname === "/api/velocity") {
    const authors = [...new Set(state.rows.map((r) => r.a))];
    const models = [...new Set(state.rows.map((r) => r.model))];
    return Response.json({ available: true, refreshing: state.refreshing, error: state.lastRefreshError, generated: meta.generated, age_ms: Date.now() - Date.parse(meta.generated), timezone: meta.timezone, since: meta.since,
      authorsLabel: meta.authorsLabel, authors, models, categories: meta.categories, repos: meta.repos.map((r) => ({ id: r.id, name: r.name, category: r.category, commits: r.commits, lastDay: r.lastDay })),
      modelTimeline: meta.models, lanes: meta.lanes ?? [], rows: state.rows.length, collect: meta.collect });
  }
  if (pathname === "/api/velocity/query") return Response.json(query(url.searchParams));
  if (pathname === "/api/velocity/presets") {
    const today = todayLocal(meta.timezone);
    const switches = [...meta.models].sort((a, b) => a.at - b.at);
    const presets: { id: string; label: string; a: { from: string; to: string }; b: { from: string; to: string } }[] = [];
    switches.forEach((s, i) => {
      if (i === 0) return;
      const day = new Date(s.at).toISOString().slice(0, 10);
      const next = i + 1 < switches.length ? addDays(new Date(switches[i + 1].at).toISOString().slice(0, 10), -1) : today;
      const len = Math.max(7, Math.min(28, daysBetween(day, next) + 1));
      presets.push({ id: `model-${i}`, label: `${switches[i - 1].label} → ${s.label} (${day})`, a: { from: addDays(day, -len), to: addDays(day, -1) }, b: { from: day, to: addDays(day, len - 1) < today ? addDays(day, len - 1) : today } });
    });
    const repoName = new Map(meta.repos.map((r) => [r.id, r.name]));
    for (const t of meta.tags.filter((t) => t.kind === "feature" || t.kind === "major").sort((a, b) => a.day.localeCompare(b.day)).slice(-24)) {
      presets.push({ id: `tag-${t.repo}-${t.tag}`, label: `${repoName.get(t.repo) ?? t.repo} ${t.tag} (${t.day})`, a: { from: addDays(t.day, -14), to: addDays(t.day, -1) }, b: { from: t.day, to: addDays(t.day, 13) < today ? addDays(t.day, 13) : today } });
    }
    return Response.json({ presets });
  }
  return null;
}
