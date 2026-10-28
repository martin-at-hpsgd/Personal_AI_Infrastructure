/**
 * STATVS views — every other piece of state is a fold of the record.
 *
 * A view is a file under MEMORY/STATE computed from STATVS rows. Each one is a module in
 * LIFEOS/STATVS/views/<file>.ts that default-exports a ViewDef: the streams and classes it
 * reads, a fold, a render and an output path. A module that registers several views (the
 * things view and its per-kind slices) exports them as `views`, an array, which is read in
 * place of the default. The registry loads every file in that directory (dynamic import),
 * sorted by file name.
 *
 * Reading a view (`readView`) loads its checkpoint `<viewsDir>/statvs-views/<name>.checkpoint.json`
 * ({ offsets, state }), folds only the rows past those offsets, and writes the output and
 * the new checkpoint. A checkpoint that will not parse, whose shape is wrong, whose offsets
 * run past a segment's end or land mid-line, or whose segment has gone, is thrown away and
 * the view refolds from the start (ISC-82). A new redaction tombstone also forces a full
 * refold, so redacted content never survives in a checkpoint or output.
 *
 * Fold authors: state must be plain JSON (it is stored in the checkpoint), and a fold must
 * not depend on the order of rows from different writers, because an incremental read folds
 * in batches while a rebuild folds everything in one (hlc, writer) order.
 *
 * Env:
 *   STATVS_VIEWS_SRC — registry directory (default LIFEOS/STATVS/views). Tests point it at a fixture dir.
 *   STATVS_VIEWS_DIR — where view outputs live (default <claudeDir>/LIFEOS/MEMORY/STATE; under
 *                      `bun test` a per-process temp dir, the record.ts test arm).
 *
 * @version 1.0.0
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getClaudeDir } from "../../TOOLS/Paths";
import { invariant } from "../../TOOLS/Invariant";
import { canonicalJson, withKernelLock } from "../../TOOLS/lib/LedgerCore";
import { listSegments, scan, statvsDir, statvsTestRoot } from "./record";
import type { PrivacyClass, StatvsRow } from "./types";
import { PRIVACY_CLASSES } from "./types";

// ── Contract ──

export interface ViewDef<S = unknown> {
  name: string;
  group?: string;
  streams: string[];
  classes: PrivacyClass[];
  /** Output path relative to the views dir (MEMORY/STATE), e.g. "statvs-views/work.json". */
  path: string;
  init(): S;
  fold(state: S, row: StatvsRow): S;
  render(state: S): unknown;
  /** The live store this view will replace, for `compare` during dual-write. May be async. */
  live?(): unknown;
}

export interface Checkpoint<S = unknown> {
  v: 1;
  view: string;
  /** The view's output path (relative to the views dir), so a redaction can remove the output without the view's definition. */
  path?: string;
  offsets: Record<string, number>;
  state: S;
  updated: string;
}

export interface ReadResult<S = unknown> {
  state: S;
  /** Rows passed to fold by this read. */
  folded: number;
  /** True when the checkpoint was missing or unusable, or a tombstone forced a refold. */
  refolded: boolean;
  /** Why it refolded, when it did. */
  reason?: string;
  /** False when the view lock could not be taken: the state is correct, nothing was written. */
  written: boolean;
  output: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const VIEW_LOCK = { deadlineMs: 5000, retryMs: 10 };

// ── Paths ──

export function viewsSrcDir(): string {
  return resolve(process.env.STATVS_VIEWS_SRC || join(import.meta.dir, "..", "views"));
}
/** Env STATVS_VIEWS_DIR, else under `bun test` the per-process temp root (the record.ts test arm), else MEMORY/STATE. */
export function viewsDir(): string {
  if (process.env.STATVS_VIEWS_DIR) return resolve(process.env.STATVS_VIEWS_DIR);
  const test = statvsTestRoot();
  return resolve(test ? join(test, "views") : join(getClaudeDir(), "LIFEOS/MEMORY/STATE"));
}
/** Checkpoint path relative to the views dir. */
export function checkpointRel(name: string): string {
  return `statvs-views/${name}.checkpoint.json`;
}

// ── Registry ──

/** Problems with a view definition, empty when it declares everything (ISC-29). */
export function validateView(v: unknown): string[] {
  const p: string[] = [];
  if (!v || typeof v !== "object") return ["not an object"];
  const d = v as Record<string, unknown>;
  const name = d.name;
  if (typeof name !== "string" || !NAME_RE.test(name) || name.split("/").some((s) => s === "." || s === "..")) p.push(`bad name: ${String(name)}`);
  if (d.group !== undefined && typeof d.group !== "string") p.push("group must be a string");
  if (!Array.isArray(d.streams) || d.streams.length === 0 || !d.streams.every((s) => typeof s === "string" && s.length > 0)) p.push("streams must be a non-empty string array");
  if (!Array.isArray(d.classes) || d.classes.length === 0 || !d.classes.every((c) => PRIVACY_CLASSES.includes(c as PrivacyClass))) p.push("classes must be a non-empty array of privacy classes");
  const path = d.path;
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).some((s) => s === ".." || s === "")) p.push(`bad path: ${String(path)}`);
  else if (typeof name === "string" && path === checkpointRel(name)) p.push("path collides with the checkpoint");
  for (const fn of ["init", "fold", "render"]) if (typeof d[fn] !== "function") p.push(`${fn} must be a function`);
  if (d.live !== undefined && typeof d.live !== "function") p.push("live must be a function");
  return p;
}

export interface Registry {
  views: ViewDef[];
  /** "<file>: <problem>" for every file that failed to load or validate; those views are excluded. */
  problems: string[];
}

const registryCache = new Map<string, Registry>();

/** Load every view module in the registry dir, sorted by file name. Cached per dir. */
export async function loadViews(src = viewsSrcDir()): Promise<Registry> {
  const key = resolve(src);
  const hit = registryCache.get(key);
  if (hit) return hit;
  const views: ViewDef[] = [];
  const problems: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(key, { withFileTypes: true })
      .filter((f) => f.isFile() && /\.(ts|js)$/.test(f.name) && !/\.test\.(ts|js)$/.test(f.name) && !f.name.startsWith("_") && !f.name.endsWith(".d.ts"))
      .map((f) => f.name)
      .sort();
  } catch { /* no registry dir yet: no views */ }
  const seen = new Set<string>();
  for (const f of files) {
    let mod: { default?: unknown; views?: unknown };
    try { mod = await import(join(key, f)); } catch (e) { problems.push(`${f}: import failed: ${(e as Error).message}`); continue; }
    for (const def of Array.isArray(mod.views) ? mod.views : [mod.default]) {
      const p = validateView(def);
      if (p.length > 0) { problems.push(...p.map((x) => `${f}: ${x}`)); continue; }
      const v = def as ViewDef;
      if (seen.has(v.name)) { problems.push(`${f}: duplicate view name ${v.name}`); continue; }
      seen.add(v.name);
      views.push(v);
    }
  }
  const reg = { views, problems };
  registryCache.set(key, reg);
  return reg;
}

/** Forget cached registries (tests swap STATVS_VIEWS_SRC). */
export function clearViewCache(): void {
  registryCache.clear();
}

export async function getView(name: string, src?: string): Promise<ViewDef | null> {
  return (await loadViews(src)).views.find((v) => v.name === name) ?? null;
}

// ── Reading rows ──

function objectPath(dir: string, h: string): string {
  return join(dir, "objects", h.slice(0, 2), `${h}.json`);
}

/** A large payload lives in objects/; give the fold the data itself. A redacted row keeps data null. */
function hydrate(row: StatvsRow, recordDir: string): StatvsRow {
  if (row.data !== null || !row.obj || !/^[a-f0-9]{64}$/.test(row.obj)) return row;
  try { return { ...row, data: JSON.parse(readFileSync(objectPath(recordDir, row.obj), "utf8")) }; } catch { return row; }
}

const isTombstone = (r: StatvsRow) => r.stream === "statvs" && r.kind === "redact";
const wants = (def: ViewDef, r: StatvsRow) => def.streams.includes(r.stream) && def.classes.includes(r.class);

/** Classes and streams to scan for a view: its own plus the system/statvs rows that carry tombstones. */
function scanFilter(def: ViewDef): { streams: string[]; classes: PrivacyClass[] } {
  return {
    streams: [...new Set([...def.streams, "statvs"])],
    classes: [...new Set<PrivacyClass>([...def.classes, "system"])],
  };
}

/**
 * Rows of a view's classes read only up to `until` (segment rel → byte offset), sorted like scan().
 * Segments absent from `until` are skipped: the folded state had never seen them. Used by the
 * drill to rebuild a view exactly as far as its live checkpoint reached.
 */
function scanUntil(dir: string, classes: PrivacyClass[], until: Record<string, number>): StatvsRow[] {
  const rows: StatvsRow[] = [];
  for (const seg of listSegments(dir, classes)) {
    const end = until[seg.rel];
    if (end === undefined || end <= 0) continue;
    let text: string;
    try {
      const fd = openSync(seg.abs, "r");
      try {
        const n = Math.min(end, fstatSync(fd).size);
        const buf = Buffer.allocUnsafe(n);
        let got = 0;
        while (got < n) { const k = readSync(fd, buf, got, n - got, got); if (k <= 0) break; got += k; }
        text = buf.subarray(0, got).toString("utf8");
      } finally { closeSync(fd); }
    } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const r = JSON.parse(line) as StatvsRow; if (r && typeof r.hlc === "string") rows.push(r); } catch { /* malformed: scan reports it */ }
    }
  }
  rows.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
  return rows;
}

// ── Checkpoints ──

/** Why a checkpoint cannot be trusted, or null when it can (ISC-82). */
function checkpointProblem(cp: unknown, recordDir: string, def: ViewDef): string | null {
  if (!cp || typeof cp !== "object") return "checkpoint is not an object";
  const c = cp as Partial<Checkpoint>;
  if (c.v !== 1 || c.view !== def.name) return "checkpoint version or view name mismatch";
  if (!("state" in c)) return "checkpoint has no state";
  if (!c.offsets || typeof c.offsets !== "object" || Array.isArray(c.offsets)) return "checkpoint offsets missing";
  for (const [rel, off] of Object.entries(c.offsets)) {
    if (typeof off !== "number" || !Number.isInteger(off) || off < 0) return `bad offset for ${rel}`;
    if (rel.split("/").some((s) => s === ".." || s === "")) return `bad segment name ${rel}`;
    const abs = join(recordDir, rel);
    let size: number;
    try { size = statSync(abs).size; } catch { return `segment ${rel} is gone`; }
    if (off > size) return `offset ${off} past the end of ${rel} (${size})`;
    if (off > 0) {
      // The byte before the offset must end a line, or a rewrite moved the rows underneath us.
      const fd = openSync(abs, "r");
      try {
        const b = Buffer.alloc(1);
        readSync(fd, b, 0, 1, off - 1);
        if (b[0] !== 10) return `offset ${off} lands mid-line in ${rel}`;
      } finally { closeSync(fd); }
    }
  }
  return null;
}

function readCheckpoint(path: string): { cp: Checkpoint | null; problem?: string } {
  if (!existsSync(path)) return { cp: null, problem: "no checkpoint" };
  try { return { cp: JSON.parse(readFileSync(path, "utf8")) as Checkpoint }; } catch (e) { return { cp: null, problem: `checkpoint unreadable: ${(e as Error).message}` }; }
}

// ── Writing ──

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/** Atomically write `content` to <root>/<rel>, confined to root after dereferencing symlinks. */
export function writeWithin(root: string, rel: string, content: string): string {
  invariant(typeof rel === "string" && rel.length > 0 && !isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."), `view path must be relative and stay inside its root: ${rel}`);
  mkdirSync(root, { recursive: true });
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, rel);
  invariant(within(rootReal, target), `view path escapes its root: ${rel}`);
  mkdirSync(dirname(target), { recursive: true });
  const parentReal = realpathSync(dirname(target));
  invariant(within(rootReal, parentReal), `view directory resolves outside its root: ${rel}`);
  const final = join(parentReal, target.slice(target.lastIndexOf(sep) + 1));
  const tmp = `${final}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, { flag: "wx" });
  renameSync(tmp, final);
  return final;
}

/** How a render result is stored: a string verbatim, anything else as pretty JSON. */
export function serialize(rendered: unknown): string {
  return typeof rendered === "string" ? rendered : JSON.stringify(rendered ?? null, null, 2) + "\n";
}

/** A stored output in comparable form: canonical JSON when it parses, the raw text otherwise. */
export function comparable(text: string): string {
  try { return canonicalJson(JSON.parse(text)); } catch { return text; }
}

// ── Folding ──

export interface FoldOptions {
  recordDir?: string;
  outDir?: string;
}

/** Ids a tombstone names. A fold never sees those rows, scrubbed yet or not (ISC-65). */
function tombstoneTargets(rows: StatvsRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!isTombstone(r)) continue;
    const t = (r.data as { target?: unknown } | null)?.target;
    if (typeof t === "string") out.add(t);
  }
  return out;
}

function full<S>(def: ViewDef<S>, recordDir: string): { state: S; offsets: Record<string, number>; folded: number } {
  const f = scanFilter(def as ViewDef);
  const { rows, offsets } = scan({ dir: recordDir, streams: f.streams, classes: f.classes });
  const gone = tombstoneTargets(rows);
  let state = def.init();
  let folded = 0;
  for (const r of rows) {
    if (!wants(def as ViewDef, r) || gone.has(r.id)) continue;
    state = def.fold(state, hydrate(r, recordDir));
    folded++;
  }
  return { state, offsets, folded };
}

function persist<S>(def: ViewDef<S>, outDir: string, state: S, offsets: Record<string, number>): void {
  invariant(Object.values(offsets).every((o) => Number.isInteger(o) && o >= 0), "checkpoint offsets must be non-negative integers");
  const cp: Checkpoint<S> = { v: 1, view: def.name, path: def.path, offsets, state, updated: new Date().toISOString() };
  invariant(NAME_RE.test(def.name), `view name must be a safe path: ${def.name}`);
  const cpText = JSON.stringify(cp);
  invariant(cpText !== undefined, "a view's checkpoint must serialize to JSON");
  writeWithin(outDir, def.path, serialize(def.render(state)));
  writeWithin(outDir, checkpointRel(def.name), cpText);
}

/**
 * Read a view: fold only the rows past its checkpoint, then write its output and checkpoint.
 * A missing or untrustworthy checkpoint, or a new tombstone, refolds from the start.
 */
export function readViewDef<S>(def: ViewDef<S>, opts: FoldOptions = {}): ReadResult<S> {
  const recordDir = resolve(opts.recordDir ?? statvsDir());
  const outDir = resolve(opts.outDir ?? viewsDir());
  const cpPath = join(outDir, checkpointRel(def.name));
  const output = join(outDir, def.path);

  const compute = (): Omit<ReadResult<S>, "written" | "output"> & { offsets: Record<string, number>; dirty: boolean } => {
    const { cp, problem: readProblem } = readCheckpoint(cpPath);
    const problem = readProblem ?? checkpointProblem(cp, recordDir, def as ViewDef);
    if (problem || !cp) {
      const r = full(def, recordDir);
      return { state: r.state, offsets: r.offsets, folded: r.folded, refolded: true, reason: problem ?? "no checkpoint", dirty: true };
    }
    const f = scanFilter(def as ViewDef);
    const { rows, offsets } = scan({ dir: recordDir, streams: f.streams, classes: f.classes, since: cp.offsets });
    if (rows.some(isTombstone)) {
      const r = full(def, recordDir);
      return { state: r.state, offsets: r.offsets, folded: r.folded, refolded: true, reason: "a redaction landed since the checkpoint", dirty: true };
    }
    let state = cp.state as S;
    let folded = 0;
    for (const r of rows) {
      if (!wants(def as ViewDef, r)) continue;
      state = def.fold(state, hydrate(r, recordDir));
      folded++;
    }
    const moved = Object.entries(offsets).some(([k, v]) => cp.offsets[k] !== v);
    return { state, offsets, folded, refolded: false, dirty: folded > 0 || moved || !existsSync(output) };
  };

  const locked = withKernelLock(cpPath + ".lock", () => {
    const r = compute();
    if (r.dirty) persist(def, outDir, r.state, r.offsets);
    return r;
  }, VIEW_LOCK);
  if (locked.ok) {
    const { offsets: _o, dirty: _d, ...rest } = locked.value;
    return { ...rest, written: true, output };
  }
  // Someone else holds the view: answer from the record without writing.
  const r = compute();
  const { offsets: _o, dirty: _d, ...rest } = r;
  return { ...rest, written: false, output };
}

/** Read a registered view by name. */
export async function readView(name: string, opts: FoldOptions & { src?: string } = {}): Promise<ReadResult> {
  const def = await getView(name, opts.src);
  if (!def) throw new Error(`no registered view named ${name}`);
  return readViewDef(def, opts);
}

export interface RebuildResult {
  view: string;
  rows: number;
  output: string;
  /** Canonical form of what was written. */
  canonical: string;
}

/** Full fold of a view from `recordDir` into `outDir`, replacing its output and checkpoint there. */
export function rebuildDef(def: ViewDef, opts: FoldOptions & { until?: Record<string, number> } = {}): RebuildResult {
  const recordDir = resolve(opts.recordDir ?? statvsDir());
  const outDir = resolve(opts.outDir ?? viewsDir());
  let state: unknown;
  let offsets: Record<string, number>;
  let rows: number;
  if (opts.until) {
    state = def.init();
    rows = 0;
    const upTo = scanUntil(recordDir, [...new Set<PrivacyClass>([...def.classes, "system"])], opts.until);
    const gone = tombstoneTargets(upTo);
    for (const r of upTo) {
      if (!wants(def, r) || gone.has(r.id)) continue;
      state = def.fold(state, hydrate(r, recordDir));
      rows++;
    }
    offsets = opts.until;
  } else {
    const r = full(def, recordDir);
    state = r.state; offsets = r.offsets; rows = r.folded;
  }
  persist(def, outDir, state, offsets);
  const text = serialize(def.render(state));
  return { view: def.name, rows, output: join(outDir, def.path), canonical: comparable(text) };
}

export async function rebuild(name: string, opts: FoldOptions & { src?: string } = {}): Promise<RebuildResult> {
  const def = await getView(name, opts.src);
  if (!def) throw new Error(`no registered view named ${name}`);
  return rebuildDef(def, opts);
}

// ── Compare ──

export interface CompareResult {
  view: string;
  equal: boolean;
  /** What the record side was compared against. */
  against: "live" | "output";
  rows: number;
  /** Paths where the two sides differ, capped at 20. */
  diff?: string[];
  reason?: string;
}

/** Paths (a.b[2]) where two JSON values differ, capped. */
export function jsonDiff(a: unknown, b: unknown, path = "$", out: string[] = [], cap = 20): string[] {
  if (out.length >= cap) return out;
  if (canonicalJson(a) === canonicalJson(b)) return out;
  const isObj = (x: unknown) => x !== null && typeof x === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length: ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < cap; i++) jsonDiff(a[i], b[i], `${path}[${i}]`, out, cap);
    return out;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = a as Record<string, unknown>, kb = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(ka), ...Object.keys(kb)])].sort()) {
      if (out.length >= cap) break;
      // compareDef passes (live, record): a key missing from `a` exists only in the record.
      if (!(k in ka)) out.push(`${path}.${k}: only in record`);
      else if (!(k in kb)) out.push(`${path}.${k}: only in live`);
      else jsonDiff(ka[k], kb[k], `${path}.${k}`, out, cap);
    }
    return out;
  }
  out.push(`${path}: differs`);
  return out;
}

/**
 * Fold the whole record and compare its render with the view's live store (live()), as
 * canonical JSON. A view with no live() is compared against its own output file. Any
 * difference is unequal: there is no tolerance, so neither side is ever preferred (ISC-59).
 */
export async function compareDef(def: ViewDef, opts: { recordDir?: string; outDir?: string } = {}): Promise<CompareResult> {
  const recordDir = resolve(opts.recordDir ?? statvsDir());
  const r = full(def, recordDir);
  const record = def.render(r.state);
  let other: unknown;
  let against: CompareResult["against"];
  if (def.live) {
    against = "live";
    try { other = await def.live(); } catch (e) { return { view: def.name, equal: false, against, rows: r.folded, reason: `live() failed: ${(e as Error).message}` }; }
  } else {
    against = "output";
    const p = join(resolve(opts.outDir ?? viewsDir()), def.path);
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch { return { view: def.name, equal: false, against, rows: r.folded, reason: "no live() and no output file" }; }
    try { other = JSON.parse(text); } catch { other = text; }
  }
  const recText = typeof record === "string" ? comparable(record) : canonicalJson(record);
  const otherText = typeof other === "string" ? comparable(other) : canonicalJson(other);
  if (recText === otherText) return { view: def.name, equal: true, against, rows: r.folded };
  const parse = (t: string): unknown => { try { return JSON.parse(t); } catch { return t; } };
  return { view: def.name, equal: false, against, rows: r.folded, diff: jsonDiff(parse(otherText), parse(recText)) };
}

export async function compare(name: string, opts: { recordDir?: string; outDir?: string; src?: string } = {}): Promise<CompareResult> {
  const def = await getView(name, opts.src);
  if (!def) throw new Error(`no registered view named ${name}`);
  return compareDef(def, opts);
}

// ── Redaction and drill support ──

/**
 * Drop every view checkpoint, and its output, that folded the segment `segRel`: after a
 * redaction those files may hold the scrubbed content (ISC-65). Each view is removed under
 * its lock, so a read in flight finishes first; the next read refolds from the record,
 * which skips tombstoned rows. Returns the names of the views removed.
 */
export function invalidateViewsFor(segRel: string, outDir = viewsDir()): string[] {
  const root = resolve(outDir);
  const dir = join(root, "statvs-views");
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".checkpoint.json")); } catch { return []; }
  const removed: string[] = [];
  for (const n of names) {
    const name = n.slice(0, -".checkpoint.json".length);
    const cpPath = join(dir, n);
    const r = withKernelLock(cpPath + ".lock", () => {
      let cp: Partial<Checkpoint> | null = null;
      try { cp = JSON.parse(readFileSync(cpPath, "utf8")) as Partial<Checkpoint>; } catch { cp = null; }
      // An unreadable checkpoint cannot prove it never saw the segment, so it goes too.
      if (cp && cp.offsets && typeof cp.offsets === "object" && !(segRel in cp.offsets)) return false;
      const rel = typeof cp?.path === "string" ? cp.path : `statvs-views/${name}.json`;
      invariant(!isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."), `view output path must stay inside the views dir: ${rel}`);
      for (const p of [join(root, rel), cpPath]) { try { unlinkSync(p); } catch { /* already gone */ } }
      return true;
    }, VIEW_LOCK);
    if (r.ok && r.value) removed.push(name);
  }
  return removed;
}

/** A view's live checkpoint offsets and output text, read together under its lock: the pair the drill compares a rebuild against. */
export function snapshotView(def: ViewDef, outDir = viewsDir()): { offsets: Record<string, number> | null; text: string | null } {
  const root = resolve(outDir);
  const cpPath = join(root, checkpointRel(def.name));
  const read = () => {
    let offsets: Record<string, number> | null = null;
    try {
      const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
      if (cp?.v === 1 && cp.view === def.name && cp.offsets && typeof cp.offsets === "object" && Object.values(cp.offsets).every((o) => Number.isInteger(o) && o >= 0)) offsets = cp.offsets;
    } catch { offsets = null; }
    let text: string | null = null;
    try { text = readFileSync(join(root, def.path), "utf8"); } catch { text = null; }
    return { offsets, text };
  };
  const r = withKernelLock(cpPath + ".lock", read, VIEW_LOCK);
  return r.ok ? r.value : read();
}

// ── Compare streak (ISC-36) ──

export interface CompareStreak {
  view: string;
  /** Consecutive calendar days (UTC), ending at the latest day with a compare row, on which every compare of this view was equal. */
  streak: number;
  /** Latest UTC day with a compare row for this view, or null when none exists. */
  latest: string | null;
  /** Days in the streak, oldest first. */
  days: string[];
  /** UTC days on which at least one compare row differed. */
  failed: string[];
  /** Hours from the first compare in the streak to the last; runs either side of midnight UTC count two days but span minutes. */
  span_hours: number;
}

const DAY_MS = 86_400_000;

/**
 * Reads the `compare --record` rows for one view and returns the run of consecutive days on which the view
 * rebuilt from the record equalled the live store. A day with any differing compare breaks the run, and a
 * day with no compare row breaks it too, so a stopped schedule cannot count as proof (ISC-36).
 */
export function compareStreak(rows: Pick<StatvsRow, "stream" | "kind" | "data" | "ts">[], view: string, opts: { since?: string } = {}): CompareStreak {
  const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity;
  const byDay = new Map<string, boolean>();
  const times = new Map<string, number[]>();
  for (const r of rows) {
    if (r.stream !== "statvs" || r.kind !== "compare") continue;
    const d = r.data as { view?: unknown; equal?: unknown } | null;
    if (!d || d.view !== view) continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms) || ms < sinceMs) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? true) && d.equal === true);
    times.set(day, [...(times.get(day) ?? []), ms]);
  }
  const failed = [...byDay].filter(([, ok]) => !ok).map(([d]) => d).sort();
  const latest = [...byDay.keys()].sort().pop() ?? null;
  const days: string[] = [];
  if (latest) {
    for (let ms = Date.parse(`${latest}T00:00:00Z`); ; ms -= DAY_MS) {
      const day = new Date(ms).toISOString().slice(0, 10);
      if (byDay.get(day) !== true) break;
      days.unshift(day);
    }
  }
  const first = days.length ? Math.min(...times.get(days[0]!)!) : 0;
  const last = days.length ? Math.max(...times.get(days[days.length - 1]!)!) : 0;
  return { view, streak: days.length, latest, days, failed, span_hours: Math.round(((last - first) / 3_600_000) * 10) / 10 };
}
