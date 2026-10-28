/**
 * Ids — stable `IS-NNNN` ids for ideal-state rows and TELOS goals.
 *
 * One namespace and one counter for both. A row's id is written into its line
 * (`— id: IS-0007`) by `IdealState.ts ids --write` or by `accept`, both on the
 * principal's word. A goal's id lives only in the state registry, because the
 * loop never writes TELOS.md: each goal keeps the id of the registry entry with
 * the same text, or failing that the closest one by shared words, so achieving,
 * rewording or deleting one goal moves no other goal's id. An issued id is never
 * reissued, even after its row or goal is gone. When a match is not clear, the old
 * id retires and the goal gets a new one: a lost link is visible, a stolen one is not.
 *
 * Only reconcile mints goal ids. Every other reader sees a goal added since the last
 * reconcile as pending (no id), so nothing can hand out the id it would get.
 *
 * The registry and the row files change only under their shared per-file locks
 * (Store.withLocks): a writer that cannot get them in time throws
 * TelosLockTimeout and writes nothing.
 *
 * @version 1.2.0
 *
 * 1.2.0: assignRowIds, issueRowId and a persisting liveGoals hold the registry
 * lock (and assignRowIds every row file's lock) from the read through the write;
 * assignRowIds checks every file before writing any (review round 3).
 *
 * 1.1.0: containment-or-Jaccard scoring with a margin (no id theft by a similar new
 * goal); pending goals; a missing registry with prior runs fails loudly; the counter
 * also clears every id reconcile has ever seen.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { allRows, dimensionFiles, ID_RE, parseGoals, parseRows, withId, type Goal } from "./Rows";
import { idealDir, readJson, statePath, userDir, withLocks, writeFileLocked, writeState, type TelosLockOptions } from "./Store";

export type GoalEntry = { id: string; text: string };
export type IdRegistry = { next: number; goals: GoalEntry[] };

export const formatId = (n: number): string => `IS-${String(n).padStart(4, "0")}`;
const idNum = (id: string): number => Number(id.slice(3));

/** The registry. A missing or unreadable file after the loop has run before is a loss, never a fresh start. */
export function loadRegistry(): IdRegistry {
  const path = statePath("ids.json");
  if (!existsSync(path)) {
    invariant(!existsSync(statePath("seen.json")), `ideal-state id registry is missing but the loop has run before (${statePath("seen.json")} exists); restore ids.json rather than reissue goal ids`);
    return { next: 1, goals: [] };
  }
  const reg = readJson<IdRegistry | null>(path, null);
  invariant(reg && typeof reg.next === "number" && Array.isArray(reg.goals), `ideal-state id registry is unreadable: ${path}`);
  return reg;
}

/** Every IS id reconcile has ever recorded; the counter stays above all of them. */
function seenIds(): string[] {
  return Object.keys(readJson<Record<string, string>>(statePath("seen.json"), {})).filter((id) => ID_RE.test(id));
}

export function saveRegistry(reg: IdRegistry): void {
  const ids = reg.goals.map((g) => g.id);
  invariant(new Set(ids).size === ids.length, "goal ids are unique in the registry");
  invariant(ids.every((id) => ID_RE.test(id) && idNum(id) < reg.next), "every registry id is below the counter");
  writeState("ids.json", reg);
}

/** The counter, lifted above every id already in use anywhere so an id is never issued twice. */
export function nextFree(reg: IdRegistry, rowIds: string[]): number {
  return Math.max(reg.next, ...[...rowIds, ...reg.goals.map((g) => g.id), ...seenIds()].filter((id) => ID_RE.test(id)).map((id) => idNum(id) + 1));
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "achieved", "dropped"]);
const words = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9$]+/g) ?? []).filter((w) => !STOP.has(w)));
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
/** 1 when one text contains the other (a goal marked achieved, a word added); otherwise Jaccard over words. */
export function similarity(a: string, b: string): number {
  if (norm(a).includes(norm(b)) || norm(b).includes(norm(a))) return 1;
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let hit = 0; for (const w of x) if (y.has(w)) hit++;
  return hit / (x.size + y.size - hit);
}
export const GOAL_MATCH = 0.6;
/** A match must beat every rival for both the goal and the old entry by this much. */
export const GOAL_MARGIN = 0.15;

/**
 * Pure: gives each goal an id, reusing registry ids by exact text, then by a clear similarity match; new goals get
 * fresh ids when `mint` is on, and stay pending (undefined) when it is off.
 */
export function assignGoalIds(goals: Goal[], reg: IdRegistry, rowIds: string[] = [], opts: { mint?: boolean } = {}): { ids: (string | undefined)[]; reg: IdRegistry } {
  const mint = opts.mint ?? true;
  const entries = reg.goals.map((g) => ({ ...g }));
  const taken = new Set<number>();
  const ids: (string | undefined)[] = goals.map(() => undefined);
  goals.forEach((g, i) => {
    const j = entries.findIndex((e, k) => !taken.has(k) && e.text === g.text);
    if (j >= 0) { taken.add(j); ids[i] = entries[j]!.id; }
  });
  // A leftover goal inherits a leftover entry only when each is the other's clear best: no rival within the margin.
  const freeGoals = goals.map((_, i) => i).filter((i) => !ids[i]);
  const freeEntries = entries.map((_, k) => k).filter((k) => !taken.has(k));
  const score = new Map(freeGoals.flatMap((i) => freeEntries.map((k) => [`${i}:${k}`, similarity(goals[i]!.text, entries[k]!.text)] as const)));
  const sc = (i: number, k: number) => score.get(`${i}:${k}`) ?? 0;
  for (const i of freeGoals) {
    const ranked = freeEntries.filter((k) => !taken.has(k)).sort((a, b) => sc(i, b) - sc(i, a));
    const k = ranked[0];
    if (k === undefined || sc(i, k) < GOAL_MATCH) continue;
    const rivalEntry = ranked[1] !== undefined ? sc(i, ranked[1]) : 0;
    const rivalGoal = Math.max(0, ...freeGoals.filter((j) => j !== i).map((j) => sc(j, k)));
    if (sc(i, k) - Math.max(rivalEntry, rivalGoal) < GOAL_MARGIN) continue;
    taken.add(k); ids[i] = entries[k]!.id; entries[k]!.text = goals[i]!.text;
  }
  let next = nextFree(reg, rowIds);
  const out = goals.map((g, i) => {
    if (ids[i] || !mint) return ids[i];
    const id = formatId(next++);
    entries.push({ id, text: g.text });
    return id;
  });
  const minted = out.filter((x): x is string => !!x);
  invariant(new Set(minted).size === minted.length, "every goal has its own id");
  return { ids: out, reg: { next, goals: entries } };
}

/**
 * Goals from the live TELOS file with their ids; `persist` records new ids in the registry (reconcile only),
 * holding the registry lock from its read through its write.
 */
export function liveGoals(opts: { persist?: boolean; telos?: string; lock?: TelosLockOptions } = {}): { goals: Goal[]; ids: (string | undefined)[] } {
  let telos = opts.telos;
  if (telos === undefined) {
    const path = join(userDir(), "TELOS", "TELOS" + ".md");
    telos = existsSync(path) ? readFileSync(path, "utf8") : ""; // unreadable throws: reconcile records it as a pursuit error
  }
  const goals = parseGoals(telos);
  const assign = () => {
    const res = assignGoalIds(goals, loadRegistry(), allRows().flatMap((r) => (r.id ? [r.id] : [])), { mint: !!opts.persist });
    if (opts.persist) saveRegistry(res.reg);
    return { goals, ids: res.ids };
  };
  return opts.persist ? withLocks([statePath("ids.json")], assign, opts.lock) : assign();
}

/**
 * Writes an id onto every ideal-state row that lacks one. Runs on the principal's word.
 * Only the suffix changes: every row parses to the same text, type, measure and pursuit before and after.
 * With `write`, every row file and the registry stay locked from the first read to the last write, and
 * every file is checked before any is written. Without it, nothing is locked or written.
 */
export function assignRowIds(opts: { write: boolean; dir?: string; lock?: TelosLockOptions }): Array<{ file: string; line: number; id: string; text: string }> {
  const dir = opts.dir ?? idealDir();
  if (!opts.write) return planRowIds(dir).out;
  return withLocks([...dimensionFiles(dir).map((f) => join(dir, f)), statePath("ids.json")], () => {
    const plan = planRowIds(dir);
    for (const w of plan.writes) writeFileLocked(w.path, w.updated, opts.lock);
    saveRegistry({ ...plan.reg, next: plan.next });
    return plan.out;
  }, opts.lock);
}

type RowIdPlan = { out: Array<{ file: string; line: number; id: string; text: string }>; writes: Array<{ path: string; updated: string }>; reg: IdRegistry; next: number };

/** The ids assignRowIds would write, and each changed file's new content, checked; writes nothing. */
function planRowIds(dir: string): RowIdPlan {
  const reg = loadRegistry();
  const existing = allRows(dir).flatMap((r) => (r.id ? [r.id] : []));
  invariant(new Set(existing).size === existing.length, "row ids are unique before assigning more");
  let next = nextFree(reg, existing);
  const out: RowIdPlan["out"] = [], writes: RowIdPlan["writes"] = [];
  for (const file of dimensionFiles(dir)) {
    const path = join(dir, file);
    const content = readFileSync(path, "utf8");
    const before = parseRows(file, content);
    const lines = content.split("\n");
    let touched = false;
    for (const r of before) {
      if (r.id) continue;
      const id = formatId(next++);
      lines[r.line - 1] = withId(lines[r.line - 1]!, id);
      out.push({ file, line: r.line, id, text: r.text });
      touched = true;
    }
    if (!touched) continue;
    const updated = lines.join("\n");
    const after = parseRows(file, updated);
    const same = (a: typeof before[number], b: typeof before[number]) => a.text === b.text && a.type === b.type && a.section === b.section && JSON.stringify(a.measure) === JSON.stringify(b.measure) && JSON.stringify(a.pursuit) === JSON.stringify(b.pursuit);
    invariant(after.length === before.length && after.every((a, i) => same(a, before[i]!) && a.id), `${file}: assigning ids changed only the suffix`);
    writes.push({ path, updated });
  }
  return { out, writes, reg, next };
}

/** One fresh id for a row being inserted (accept). Advances the counter under the registry lock. */
export function issueRowId(opts: { lock?: TelosLockOptions } = {}): string {
  return withLocks([statePath("ids.json")], () => {
    const reg = loadRegistry();
    const n = nextFree(reg, allRows().flatMap((r) => (r.id ? [r.id] : [])));
    saveRegistry({ ...reg, next: n + 1 });
    return formatId(n);
  }, opts.lock);
}
