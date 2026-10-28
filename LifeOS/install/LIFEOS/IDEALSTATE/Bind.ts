/**
 * Bind — the binding sitting: every obvious row-to-measurement match at once.
 *
 * `proposeAll` matches each unbound target row to the one catalog path that
 * measures it, by a fixed metric table (resting heart rate, HRV, sleep hours,
 * steps, MRR and so on), deterministically and without a model. A row is
 * proposed only when it names exactly one known metric, states a target number,
 * and some catalog path for that metric reads a number today. It writes nothing.
 *
 * `acceptBatch` lands the whole proposed batch on the principal's one yes: the
 * batch id he saw must still match what propose-all computes now, each touched
 * ideal-state file is backed up first, and every binding is recorded as an
 * accepted recommendation carrying its measurement reason. This is a
 * principal-initiated action, so the weekly recommend cap of 2 open bindings
 * does not apply to it.
 *
 * The whole accept, from the batch check through the last write, holds the shared
 * per-file lock of every ideal-state file and of the recommendations store, taken
 * up front in lock order: another writer cannot land between the read and the
 * write, and a busy lock throws TelosLockTimeout before anything is written.
 *
 * @version 1.1.0
 *
 * 1.1.0: accept holds the ideal-state and store locks across read and write (review round 3).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { readValue } from "./Reconcile";
import { dataCatalog, loadStore, newId, saveStore, setFrontmatter, type Rec } from "./Recommend";
import { allRows, dimensionFiles, formatMeasure, goalBy, parseRows, rowRef, type NumericMeasure, type Row } from "./Rows";
import { idealDir, lockOrder, statePath, userDir, withLocks, writeFileLocked, type TelosLockOptions } from "./Store";

const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A row that names no date of its own gets this horizon unless `--by` sets one. */
export const DEFAULT_HORIZON_DAYS = 365;

type Matcher = { metric: string; leaf: RegExp; row: RegExp };
/** One entry per metric a catalog leaf can measure. Leaf names are the data files' own keys. */
export const MATCHERS: readonly Matcher[] = [
  { metric: "resting heart rate", leaf: /^(rhr|resting_hr|resting_heart_rate)(_bpm)?(_avg_(7|30)d)?$/, row: /\bresting heart rate\b|\bRHR\b/i },
  { metric: "heart rate variability", leaf: /^hrv(_ms)?(_avg_(7|30)d)?$/, row: /\bHRV\b|\bheart rate variability\b/i },
  { metric: "sleep hours", leaf: /^sleep_(h|hours)(_avg_(7|30)d)?$/, row: /\bsleep\b[^.;]*\bhours?\b|\bhours? of sleep\b/i },
  { metric: "sleep score", leaf: /^sleep_score(_avg_(7|30)d)?$/, row: /\bsleep score\b/i },
  { metric: "sleep efficiency", leaf: /^sleep_efficiency(_avg_(7|30)d)?$/, row: /\bsleep efficiency\b/i },
  { metric: "steps", leaf: /^steps(_avg_(7|30)d)?$/, row: /\bsteps\b/i },
  { metric: "readiness", leaf: /^readiness(_score)?(_avg_(7|30)d)?$/, row: /\breadiness\b/i },
  { metric: "body weight", leaf: /^(body_)?weight(_kg)?$/, row: /\bweight\b/i },
  { metric: "monthly recurring revenue", leaf: /^(stripe_)?mrr(_usd)?$/, row: /\bMRR\b|\bmonthly recurring revenue\b/i },
  { metric: "creation-to-consumption ratio", leaf: /^creation_ratio(_(7|30)d)?$/, row: /\bcreation[- ](to[- ])?consumption\b|\bcreation ratio\b/i },
];

export type Proposal = {
  id: string; ref: string; file: string; section: string; text: string;
  measure: NumericMeasure; value: number; reason: string;
  /** Where the date came from: the row's own words, the --by flag, or the default horizon. */
  by_source: "row" | "flag" | "default";
};
export type Skip = { id: string; file: string; text: string; why: string };
export type ProposeResult = { batch: string; generated_at: string; proposals: Proposal[]; skipped: Skip[] };

/** The target number a row states: the first number after its bold label, with $ and K/M read, years skipped. */
export function targetNumber(text: string): number | null {
  const body = text.replace(/^\*\*[^*]+\*\*:?\s*/, "");
  for (const m of body.matchAll(/(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*([KkMm])\b)?/g)) {
    const raw = m[1]!.replace(/,/g, ""), suffix = m[2]?.toUpperCase();
    if (!suffix && /^(19|20)\d{2}$/.test(raw)) continue; // a year, not a target
    const n = Number(raw) * (suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : 1);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const windowRank = (leaf: string): number => (/_30d$/.test(leaf) ? 0 : /_7d$/.test(leaf) ? 2 : 1);
const windowWords = (leaf: string): string => (/_30d$/.test(leaf) ? "30-day average " : /_7d$/.test(leaf) ? "7-day average " : "");
const sourceName = (file: string): string => (file === "CACHE/state-evidence.json" ? "the state-evidence cache" : file);
const label = (r: Row): string => r.id ?? r.key;

function plusDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY).toISOString().slice(0, 10);
}

/** Every obvious binding, read-only. `by` sets the date for rows that name none. */
export function proposeAll(opts: { now?: Date; by?: string; rows?: Row[]; catalog?: string[]; root?: string } = {}): ProposeResult {
  const now = opts.now ?? new Date();
  if (opts.by !== undefined && (!DATE_RE.test(opts.by) || Date.parse(`${opts.by}T00:00:00Z`) <= now.getTime())) throw new Error(`--by must be a future date YYYY-MM-DD, got ${opts.by}`);
  const root = opts.root ?? userDir();
  const rows = opts.rows ?? allRows();
  const catalog = opts.catalog ?? dataCatalog(root);
  const proposals: Proposal[] = [], skipped: Skip[] = [];
  for (const row of rows) {
    if (row.type !== "target") continue;
    const hits = MATCHERS.filter((m) => m.row.test(row.text));
    if (hits.length === 0) continue; // names no metric the catalog can measure
    const skip = (why: string) => skipped.push({ id: label(row), file: row.file, text: row.text, why });
    if (row.measure) { skip("already bound"); continue; }
    if (/\bTBD\b/.test(row.text)) { skip("its target is TBD"); continue; }
    if (hits.length > 1) { skip(`names more than one metric (${hits.map((h) => h.metric).join(", ")})`); continue; }
    const hit = hits[0]!;
    const target = targetNumber(row.text);
    if (target === null) { skip("no target number in the row"); continue; }
    const paths = catalog
      .map((ref, i) => ({ ref, i, leaf: ref.slice(ref.lastIndexOf(".") + 1) }))
      .filter((c) => c.ref.includes("#") && hit.leaf.test(c.leaf))
      .sort((a, b) => windowRank(a.leaf) - windowRank(b.leaf) || a.i - b.i);
    const rowBy = goalBy(row.text);
    if (rowBy && Date.parse(`${rowBy}T00:00:00Z`) <= now.getTime()) { skip(`its date ${rowBy} has passed`); continue; }
    const by = rowBy ?? opts.by ?? plusDays(now, DEFAULT_HORIZON_DAYS);
    const by_source: Proposal["by_source"] = rowBy ? "row" : opts.by ? "flag" : "default";
    let found: Proposal | null = null;
    for (const c of paths) {
      const [file, path] = c.ref.split("#") as [string, string];
      const measure: NumericMeasure = { file, path, target, by };
      let value: number;
      try { value = readValue({ ...row, measure }, root); } catch { continue; } // must read a number today
      found = { id: label(row), ref: rowRef(row), file: row.file, section: row.section, text: row.text, measure, value, by_source,
        reason: `${windowWords(c.leaf)}${hit.metric} from ${sourceName(file)}, the metric this row names, toward its stated ${target}` };
      break;
    }
    if (!found) { skip(`no catalog path reads a number today for ${hit.metric}`); continue; }
    proposals.push(found);
  }
  const batch = `BIND-${createHash("sha256").update(JSON.stringify(proposals.map((p) => [p.ref, p.file, formatMeasure(p.measure)]))).digest("hex").slice(0, 10)}`;
  return { batch, generated_at: now.toISOString(), proposals, skipped };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** A backup path that does not exist yet: TELOS/Backups/IDEAL_STATE_<file>.<stamp>[-n]. */
function backupPath(file: string, now: Date): string {
  const dir = join(userDir(), "TELOS", "Backups");
  const base = join(dir, `IDEAL_STATE_${file}.${stamp(now)}`);
  let path = base;
  for (let n = 2; existsSync(path); n++) path = `${base}-${n}`;
  return path;
}

type AcceptResult = { batch: string; bound: Proposal[]; backups: string[]; superseded: string[] };

/**
 * Lands the batch the principal said yes to. `batch` is the id propose-all showed him, or
 * "all" for whatever propose-all shows now. Pass the same `by` he saw, or the id will not match.
 */
export function acceptBatch(batch: string, opts: { now?: Date; by?: string; lock?: TelosLockOptions } = {}): AcceptResult {
  // propose-all reads every dimension file, so every one is held, with the store, before the batch check.
  const held = [...dimensionFiles().map((f) => join(idealDir(), f)), statePath("recommendations.json")];
  return withLocks(held, () => acceptLocked(batch, opts, new Set(lockOrder(held))), opts.lock);
}

function acceptLocked(batch: string, opts: { now?: Date; by?: string }, held: Set<string>): AcceptResult {
  const now = opts.now ?? new Date();
  const current = proposeAll({ now, ...(opts.by ? { by: opts.by } : {}) });
  if (current.proposals.length === 0) throw new Error("nothing to bind: no unbound row has an obvious measurement today");
  if (batch !== "all" && batch !== current.batch) throw new Error(`batch ${batch} changed since it was shown (it is ${current.batch} now): run \`IdealState.ts bind --propose-all\` again`);

  // Compute every new file first; nothing is written until all of them check out.
  const files = [...new Set(current.proposals.map((p) => p.file))];
  const known = dimensionFiles();
  const writes: Array<{ path: string; before: string; after: string; file: string }> = [];
  for (const file of files) {
    invariant(known.includes(file), `binding target is an ideal-state dimension file: ${file}`);
    const path = join(idealDir(), file);
    invariant(held.has(lockOrder([path])[0]!), `${file} was locked before its read`);
    const before = readFileSync(path, "utf8");
    const lines = before.split("\n");
    const mine = current.proposals.filter((p) => p.file === file);
    const parsed = parseRows(file, before);
    for (const p of mine) {
      const row = parsed.find((r) => rowRef(r) === p.ref);
      invariant(row && !row.measure, `row ${p.id} is in ${file} and unbound`);
      lines[row.line - 1] = `${lines[row.line - 1]!.replace(/\s+$/, "")} — measure: ${formatMeasure(p.measure)}`;
    }
    const after = setFrontmatter(lines.join("\n"), "last_updated", now.toISOString().slice(0, 10));
    const reparsed = parseRows(file, after);
    for (const p of mine) invariant(JSON.stringify(reparsed.find((r) => rowRef(r) === p.ref)?.measure) === JSON.stringify(p.measure), `row ${p.id} parses as bound to its proposal after the write`);
    invariant(reparsed.length === parsed.length, `binding ${file} keeps every row`);
    writes.push({ path, before, after, file });
  }

  // Back up each file, then write it.
  const backups: string[] = [];
  mkdirSync(join(userDir(), "TELOS", "Backups"), { recursive: true });
  for (const w of writes) {
    const b = backupPath(w.file, now);
    copyFileSync(w.path, b);
    invariant(readFileSync(b, "utf8") === w.before, `backup of ${w.file} holds its bytes from before the write`);
    backups.push(b);
  }
  for (const w of writes) writeFileLocked(w.path, w.after);

  // Record each binding with its reason; an open recommendation for a row just bound is superseded.
  const store = loadStore();
  const refs = new Set(current.proposals.map((p) => p.ref));
  const superseded: string[] = [];
  for (const r of store.recs) if (r.status === "open" && r.kind === "binding" && r.row_key && refs.has(r.row_key)) { r.status = "expired"; r.decided = now.toISOString(); superseded.push(r.id); }
  for (const p of current.proposals) {
    invariant(p.reason.trim().length > 0, `binding ${p.id} carries a measurement reason`);
    const rec: Rec = { id: newId(now), kind: "binding", status: "accepted", created: now.toISOString(), decided: now.toISOString(), source_id: `ROW-${p.ref}`, source_kind: "unbound",
      row_key: p.ref, file: p.file, section: p.section, text: p.text, measure: p.measure, why: p.reason, batch: current.batch };
    store.recs.push(rec);
  }
  saveStore(store);
  return { batch: current.batch, bound: current.proposals, backups, superseded };
}
