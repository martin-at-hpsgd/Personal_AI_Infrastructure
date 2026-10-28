/**
 * The connected situation of a RES at a moment (CENSVS ISA F12, ISC-54): what a replay needs to put a
 * past failure back together. One walk over RES links replaces a hunt across stores.
 *
 * buildSituation(root, { at, depth, windowMs }) returns:
 *   res    the root and every RES reachable from it through parent, children and links in both
 *          directions, to `depth` steps (default 2), each folded as of `at` (views/things.ts thingsAt)
 *   rows   every row whose subject is one of those ids (named on the row, or derived from it by the
 *          one resolver STATVS core uses, core/lib/subject.ts indexSubject) with ts in
 *          (at - window, at] and known to the record at `at`; window default 24 h; hlc order
 *   turn   the turn row nearest before `at` for any session RES in the set, when there is one
 *   env    the environment that turn row recorded (repo heads and whatever later turn rows add)
 *
 * writeSituation() stores it as one JSON file, mode 0600, under
 * LIFEOS/MEMORY/STATE/censvs/situations/<id>-<stamp>.json (CENSVS_SITUATIONS_DIR overrides). The file
 * shape is the contract the replay lane reads:
 *   { v: 1, at, root, depth, window, res: Res[], rows: StatvsRow[], turn?, env?, missing? }
 * `missing` lists reachable ids that were not defined at `at` (a link to a RES created later, or
 * one only named by rows). Customer-class rows never enter: a RES holds no customer content.
 *
 * Reads only, except the one file writeSituation() writes.
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md * @version 1.0.0
 */
import { closeSync, constants, fchmodSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { StatvsRow } from "../STATVS/index";
import { indexSubject } from "../STATVS/core/lib/subject";
import { atMs, hlcMs, knownAt, thingsAt } from "../STATVS/views/things";
import type { ThingRes } from "../STATVS/views/things";
import { invariant } from "../TOOLS/Invariant";
import { principalTimezone } from "../TOOLS/lib/Timezone";
import { parseSubject } from "./genera";

export const DEFAULT_DEPTH = 2;
export const DEFAULT_WINDOW_MS = 24 * 3_600_000;
export const MAX_DEPTH = 8;

export interface Situation {
  v: 1;
  /** The moment, ISO UTC. */
  at: string;
  root: string;
  depth: number;
  /** The row window: (from, to], ISO UTC; `to` equals `at`. */
  window: { from: string; to: string };
  res: ThingRes[];
  rows: StatvsRow[];
  turn?: StatvsRow;
  env?: Record<string, unknown>;
  missing?: string[];
}

export interface SituationOpts {
  at: number | string | Date;
  depth?: number;
  windowMs?: number;
  recordDir?: string;
}

// ── time words ───────────────────────────────────────────────────────────────

/** The UTC epoch of a wall-clock time in `zone`. Two passes settle a DST edge. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const want = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(guess))
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    const seen = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    guess += want - seen;
  }
  return guess;
}

function zone(): string {
  try {
    return principalTimezone();
  } catch {
    return "UTC";
  }
}

/**
 * A time from the command line, as epoch ms. Accepts an ISO time with a zone (`2026-10-18T09:00:00Z`,
 * `…+02:00`), a local date and time in the principal's zone (`2026-10-18 09:00`, `2026-10-18T09:00`),
 * a local date (midnight there), or a local `HH:mm[:ss]` today. Returns null for anything else.
 */
export function parseAt(text: string, now = Date.now(), tz = zone()): number | null {
  const t = text.trim();
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (clock) {
    const [h, mi, s] = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)];
    if (h > 23 || mi > 59 || s > 59) return null;
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return zonedToUtc(p.year!, p.month!, p.day!, h, mi, s, tz);
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (local) {
    const [y, mo, d, h, mi, s] = local.slice(1).map((v) => Number(v ?? 0));
    if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59 || s! > 59) return null;
    return zonedToUtc(y!, mo!, d!, h!, mi!, s!, tz);
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** A window like `24h`, `90m`, `2d`, `30s`, or a bare number of hours, as ms; null when unreadable. */
export function parseWindow(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, "": 3_600_000 }[m[2] as "s" | "m" | "h" | "d" | ""];
  const ms = n * unit;
  return ms > 0 && Number.isFinite(ms) ? ms : null;
}

// ── the walk ─────────────────────────────────────────────────────────────────

/** Undirected neighbours of every id in the folded view: parent, children, links out and links in. */
function graph(res: Record<string, ThingRes>): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  const edge = (a: string, b: string) => {
    if (a === b) return;
    (g.get(a) ?? g.set(a, new Set()).get(a)!).add(b);
    (g.get(b) ?? g.set(b, new Set()).get(b)!).add(a);
  };
  for (const r of Object.values(res)) {
    if (r.parent) edge(r.id, r.parent);
    for (const l of r.links ?? []) edge(r.id, l.to);
  }
  return g;
}

/** Every id within `depth` steps of `root`, root first, then by distance and id. */
export function reachable(res: Record<string, ThingRes>, root: string, depth: number): string[] {
  const g = graph(res);
  const dist = new Map<string, number>([[root, 0]]);
  let frontier = [root];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const n of [...(g.get(id) ?? [])].sort()) if (!dist.has(n)) { dist.set(n, d); next.push(n); }
    frontier = next;
  }
  return [...dist.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id]) => id);
}

const ENV_KEYS = ["heads", "commits", "model", "effort", "cwd", "diff", "untracked", "seat_idle_min"] as const;

/** Build the situation of `root` at `opts.at`. Reads the record; writes nothing. */
export function buildSituation(root: string, opts: SituationOpts): Situation {
  invariant(parseSubject(root) !== null, `situation: "${root}" is not a <kind>:<key> id`);
  const ms = atMs(opts.at);
  const depth = opts.depth ?? DEFAULT_DEPTH;
  invariant(Number.isInteger(depth) && depth >= 0 && depth <= MAX_DEPTH, `situation: depth must be an integer 0..${MAX_DEPTH}, got ${depth}`);
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  invariant(Number.isFinite(windowMs) && windowMs > 0, `situation: the window must be a positive duration, got ${windowMs}`);

  const past = thingsAt(ms, opts.recordDir ? { recordDir: opts.recordDir } : {});
  const ids = reachable(past.view.res, root, depth);
  const set = new Set(ids);
  const res = ids.flatMap((id) => (past.view.res[id] ? [past.view.res[id]!] : []));
  const missing = ids.filter((id) => !past.view.res[id]);

  // thingsAt already cut every row to `at`, dropped customer rows and redacted ones, and hydrated payloads.
  const from = ms - windowMs;
  const subjectOf = (r: StatvsRow) => indexSubject(r as never);
  const rows = past.rows.filter((r) => {
    const s = subjectOf(r);
    if (s === null || !set.has(s)) return false;
    const t = Date.parse(r.ts);
    const when = Number.isFinite(t) ? t : hlcMs(r.hlc);
    return when > from;
  });

  const sessions = new Set(ids.filter((id) => parseSubject(id)?.kind === "session"));
  let turn: StatvsRow | undefined;
  if (sessions.size) {
    for (const r of past.rows) {
      if (r.stream !== "turn" || !knownAt(r, ms)) continue;
      const s = subjectOf(r);
      if (s === null || !sessions.has(s)) continue;
      if (!turn || r.hlc > turn.hlc) turn = r;
    }
  }
  let env: Record<string, unknown> | undefined;
  if (turn && turn.data && typeof turn.data === "object" && !Array.isArray(turn.data)) {
    const d = turn.data as Record<string, unknown>;
    const picked = Object.fromEntries(ENV_KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
    if (Object.keys(picked).length) env = { ...picked, session: turn.session ?? null, turn_ts: turn.ts };
  }

  const out: Situation = {
    v: 1,
    at: new Date(ms).toISOString(),
    root,
    depth,
    window: { from: new Date(from).toISOString(), to: new Date(ms).toISOString() },
    res,
    rows,
  };
  if (turn) out.turn = turn;
  if (env) out.env = env;
  if (missing.length) out.missing = missing;
  return out;
}

// ── storing it ───────────────────────────────────────────────────────────────

/** LIFEOS/MEMORY/STATE/censvs/situations, or CENSVS_SITUATIONS_DIR. */
export function situationsDir(): string {
  return resolve(process.env.CENSVS_SITUATIONS_DIR || join(import.meta.dir, "..", "MEMORY", "STATE", "censvs", "situations"));
}

/** `<id>-<stamp>.json`, the id made filesystem-safe (`:` and anything outside [A-Za-z0-9._-] become `_`). */
export function situationFileName(s: Pick<Situation, "root" | "at">): string {
  const id = s.root.replace(/[^A-Za-z0-9._-]/g, "_");
  const stamp = s.at.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${id}-${stamp}.json`;
}

/** Write the situation as one JSON file, mode 0600, and return its path. `path` overrides the default location. */
export function writeSituation(s: Situation, opts: { dir?: string; path?: string } = {}): string {
  invariant(s && s.v === 1 && parseSubject(s.root) !== null && Array.isArray(s.res) && Array.isArray(s.rows), "situation: refusing to write a malformed situation");
  invariant(Number.isFinite(Date.parse(s.at)) && Number.isInteger(s.depth), "situation: at and depth must be set");
  invariant(s.rows.every((r) => r.class !== "customer"), "situation: a customer-class row may never be written into a situation");
  const dir = resolve(opts.path ? dirname(opts.path) : opts.dir ?? situationsDir());
  const file = opts.path ? resolve(opts.path) : join(dir, situationFileName(s));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Dereference symlinks before the boundary check, so a symlinked component cannot carry the write elsewhere.
  const realDir = realpathSync(dir);
  const realFile = join(realDir, relative(dir, file));
  invariant(dirname(realFile) === realDir && !relative(realDir, realFile).startsWith(".." + sep), `situation: ${file} is outside ${dir}`);
  const text = JSON.stringify(s, null, 2) + "\n";
  invariant(JSON.parse(text).root === s.root, "situation: the file must round-trip");
  // O_NOFOLLOW: realpathSync(dir) covers the directory chain only; a symlink already sitting at the filename would
  // otherwise carry the write (and the chmod) to its target. open() refuses it with ELOOP instead.
  const fd = openSync(realFile, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return file;
}
