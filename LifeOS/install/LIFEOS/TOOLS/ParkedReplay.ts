#!/usr/bin/env bun
/**
 * @version 1.0.1
 * ParkedReplay — give back the reviewer memory writes that ledger drift refused.
 *
 *   bun LIFEOS/TOOLS/ParkedReplay.ts [--dry-run] [--since ISO]
 *
 * While a memory file disagreed with the Cortex ledger, every reviewer write to
 * it was refused (EDRIFT) and parked in reviewer-failed-items.jsonl. Each parked
 * item is a FULL desired entry list built on a base that no longer exists, so a
 * replay applies only its additions: entries that were not in the file when the
 * reviewer read it, are not in it now, and were never held by the ledger (an
 * entry the ledger once held and no longer does was removed on purpose). Nothing
 * is ever dropped. Additions fill the file up to its entry cap, newest items
 * first; an item whose additions did not all fit stays parked and retries after
 * the reviewer has consolidated. Each item replays once;
 * LIFEOS/MEMORY/STATE/parked-replay.json records which.
 *
 * The first run on an install seeds a floor: without --since, only items parked
 * after that moment are eligible, so old refusals already reconciled by hand are
 * never re-applied. Callers: `CortexLedger.ts adopt`, CommitOwn after it adopts,
 * and the memory reviewer at the start of each run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { foldState, readRows, sha256 } from "./lib/CortexLedgerCore";
import { invariant } from "./Invariant";
import { MAX_ENTRIES, cleanGitEnv, parseMemoryContent, setEntries, validateAndDedup } from "./MemoryWriter";
import { getClaudeDir } from "./Paths";

// The config root, not getLifeosDir(), on purpose: MemoryReviewer writes the parked file under getClaudeDir()/LIFEOS and the
// Cortex ledger keys memory files relative to the same root, so a LIFEOS_DIR relocation must not move only this reader.
const ROOT = getClaudeDir();
const PARKED = resolve(ROOT, "LIFEOS/MEMORY/OBSERVABILITY/reviewer-failed-items.jsonl");
const STATE = resolve(ROOT, "LIFEOS/MEMORY/STATE/parked-replay.json");
const FILE_FOR: Record<string, string> = {
  principal: "LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md",
  assistant: "LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md",
};

interface ReplayState { floor: string; replayed: string[] }
interface Parked { key: string; ts: string; rel: string; entries: string[] }

export interface ReplayReport {
  applied: string[];
  added: number;
  files: Record<string, { items: number; additions: string[]; held: string[]; written: boolean; error?: string }>;
}

function readState(): ReplayState | null {
  try { return JSON.parse(readFileSync(STATE, "utf8")) as ReplayState; } catch { return null; }
}

function writeState(s: ReplayState): void {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n", "utf8");
}

/** Parked reviewer memory sets that EDRIFT refused, newest last. */
function parkedDriftItems(): Parked[] {
  if (!existsSync(PARKED)) return [];
  const out: Parked[] = [];
  for (const line of readFileSync(PARKED, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: { ts?: string; type?: string; error?: string; item?: { actor?: string; op?: string; entries?: unknown } };
    try { row = JSON.parse(line); } catch { continue; }
    const rel = FILE_FOR[row.item?.actor ?? ""];
    if (row.type !== "memory" || row.item?.op !== "set" || !rel || !/EDRIFT/.test(row.error ?? "")) continue;
    if (!Array.isArray(row.item.entries) || typeof row.ts !== "string") continue;
    out.push({ key: sha256(line), ts: row.ts, rel, entries: row.item.entries.filter((e): e is string => typeof e === "string") });
  }
  return out;
}

/** The file's entries in git as of `ts` (the last commit at or before it), through symlinks. */
function gitEntriesAt(rel: string, ts: string): string[] {
  try {
    const real = realpathSync(resolve(ROOT, rel));
    const env = cleanGitEnv();
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(real), encoding: "utf8", env });
    if (top.status !== 0) return [];
    const repo = realpathSync(top.stdout.trim());
    const path = relative(repo, real);
    const sha = spawnSync("git", ["log", "-1", `--before=${ts}`, "--format=%H", "--", path], { cwd: repo, encoding: "utf8", env }).stdout.trim();
    if (!sha) return [];
    const show = spawnSync("git", ["show", `${sha}:${path}`], { cwd: repo, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 });
    return show.status === 0 ? parseMemoryContent(show.stdout).entries : [];
  } catch {
    return [];
  }
}

/** Every entry the ledger has ever folded for `rel`. */
function everFolded(rel: string): Set<string> {
  const seen = new Set<string>();
  for (const row of readRows()) {
    if (row.kind === "checkpoint") {
      const content = (row.files as Record<string, string> | undefined)?.[rel];
      if (content) for (const e of parseMemoryContent(content).entries) seen.add(e);
    } else if (row.file === rel && typeof row.content === "string") {
      for (const e of parseMemoryContent(row.content as string).entries) seen.add(e);
    }
  }
  return seen;
}

function ledgerEntriesAt(rel: string, ts: string): string[] {
  try {
    const head = foldState(ts).files.get(rel);
    return head ? parseMemoryContent(head).entries : [];
  } catch {
    return []; // ts before the retained horizon
  }
}

export function replayParked(opts: { dryRun?: boolean; since?: string }): ReplayReport {
  const report: ReplayReport = { applied: [], added: 0, files: {} };
  let state = readState();
  if (opts.since) {
    invariant(!Number.isNaN(Date.parse(opts.since)), `--since must be an ISO time: ${opts.since}`);
    state = { floor: opts.since, replayed: state?.replayed ?? [] };
  } else if (state === null) {
    // First automated run: arm for future refusals only.
    if (!opts.dryRun) writeState({ floor: new Date().toISOString(), replayed: [] });
    return report;
  }
  const done = new Set(state.replayed);
  const pending = parkedDriftItems().filter((p) => Date.parse(p.ts) >= Date.parse(state.floor) && !done.has(p.key));

  const byFile = new Map<string, Parked[]>();
  for (const p of pending) byFile.set(p.rel, [...(byFile.get(p.rel) ?? []), p]);

  for (const [rel, items] of byFile) {
    const abs = resolve(ROOT, rel);
    const live = parseMemoryContent(readFileSync(abs, "utf8")).entries;
    const held = everFolded(rel);
    const liveSet = new Set(live);
    const additions: string[] = [];
    const overCap: string[] = [];
    const complete: Parked[] = [];
    const room = MAX_ENTRIES - live.length;
    for (const item of [...items].reverse()) { // newest first: it reflects the most recent conversation
      const base = new Set([...gitEntriesAt(rel, item.ts), ...ledgerEntriesAt(rel, item.ts)]);
      let fits = true;
      for (const e of item.entries) {
        if (base.has(e) || liveSet.has(e) || held.has(e) || additions.includes(e)) continue;
        if (additions.length < room) additions.push(e);
        else { fits = false; if (!overCap.includes(e)) overCap.push(e); }
      }
      if (fits) complete.push(item);
    }
    const entry: ReplayReport["files"][string] = { items: items.length, additions, held: overCap, written: false };
    report.files[rel] = entry;
    if (opts.dryRun) continue;
    if (additions.length > 0) {
      // The fingerprint of the read above, the way the reviewer computes it: a write that
      // landed since (the git lookups widen the window) refuses this one with ESTALE_BASE
      // instead of being evicted by it (Astra audit of de9d79013).
      const expectedFingerprint = sha256(JSON.stringify(validateAndDedup(live).accepted));
      const res = setEntries(abs, [...live, ...additions], { updatedBy: "ParkedReplay", expectedFingerprint });
      if (!res.ok) {
        entry.error = `${res.code}: ${res.message}`;
        continue; // left unmarked; the next replay tries again
      }
      invariant(live.every((e) => res.ok && !res.evictions.includes(e)), "replay must never drop an entry");
      entry.written = true;
      report.added += res.additions.length;
    }
    for (const item of complete) { done.add(item.key); report.applied.push(item.key); }
  }

  if (!opts.dryRun) writeState({ floor: state.floor, replayed: [...done] });
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--since");
  const r = replayParked({ dryRun: args.includes("--dry-run"), since: i >= 0 ? args[i + 1] : undefined });
  console.log(JSON.stringify(r, null, 2));
  process.exit(Object.values(r.files).some((f) => f.error) ? 1 : 0);
}
