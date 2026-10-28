#!/usr/bin/env bun
/**
 * MoveCursors: carry collection state from Vigil's state dir to STATVS's at the switch, and back
 * for a rollback (migration design §3 Lane C, §4.3 step 8, §7; S4, S5, S13). One-shot; deleted in p3.
 *
 *   bun LIFEOS/STATVS/tools/MoveCursors.ts [--dry-run]          old root → new root
 *   bun LIFEOS/STATVS/tools/MoveCursors.ts --back [--dry-run]   new root → old root
 *
 * Forward it COPIES (never moves):
 *  - `cursors/*.json` (cursor values and `<name>.read.json` outcomes) and the whole `inbox/` tree;
 *  - seeds consumer `cloud-pull` (`<statvsStateDir()>/consumers/cloud-pull.json`, `{ since }`) from
 *    `store-reader.json`, so the first pull continues from the last legacy pull;
 *  - writes `<new root>/pulled-seed.json` (`{ ids }`) from the ids in `pulled.jsonl`, so the overlap
 *    window never re-pulls a row the legacy tick already pulled.
 * `--back` copies the collect cursors and inbox back to the old root and sets `store-reader.json`
 * from consumer `cloud-pull`.
 *
 * It never overwrites a destination file newer than its source (a fresh Slack message, a cursor the
 * other side advanced): it names every file it skipped. Symlinks are never followed. Every write is
 * confined to its destination root after resolving symlinks.
 *
 * Roots: old = Vigil's state dir (VIGIL_STATE_DIR, else the test temp dir under `bun test`, else
 * ~/.local/state/lifeos/vigil); new = `<statvsStateDir()>/collect`. Identical roots are refused.
 * Run it only in the switch window, with vigil-tick, watch-slack and statvs-collect paused.
 *
 * @version 1.0.0
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { invariant } from "../../TOOLS/Invariant";
import { statvsStateDir } from "../lib/record";

/** Vigil's state dir, the collection root before the switch (State.ts's rule). */
export const legacyRoot = (): string =>
  resolve(process.env.VIGIL_STATE_DIR || (process.env.NODE_ENV === "test" ? join(tmpdir(), `lifeos-vigil-state-test-${process.pid}`) : join(homedir(), ".local/state/lifeos/vigil")));
/** The collection root after the switch. */
export const collectRoot = (): string => resolve(join(statvsStateDir(), "collect"));
/** Consumer `cloud-pull`'s file: the pull's D1 cursor, `{ since }` (Lane B's cloud.ts reads it). */
export const cloudPullPath = (): string => join(statvsStateDir(), "consumers", "cloud-pull.json");
/** The ids the legacy tick already pulled, consulted by the pull until p3. */
export const pulledSeedPath = (): string => join(collectRoot(), "pulled-seed.json");

export type MoveReport = {
  direction: "forward" | "back"; from: string; to: string; dry_run: boolean;
  copied: string[]; skipped: Array<{ path: string; why: string }>;
  seeded: { cloud_pull?: string; pulled_seed?: number; store_reader?: string };
};

/** The real path of `p`'s nearest existing ancestor joined with the rest: a symlinked component cannot escape `root`. */
function realish(p: string): string {
  let head = resolve(p); const tail: string[] = [];
  while (!existsSync(head)) { tail.unshift(basename(head)); const up = dirname(head); if (up === head) break; head = up; }
  return join(realpathSync(head), ...tail);
}
function within(root: string, p: string): boolean {
  const r = realish(root), q = realish(p);
  return q === r || q.startsWith(r + sep);
}
const mtime = (p: string): number => statSync(p).mtimeMs;

/** Copy one file unless the destination is newer; preserves the source mtime so a later comparison stays honest. */
function copyOne(src: string, dst: string, toRoot: string, report: MoveReport): void {
  const rel = relative(toRoot, dst);
  if (existsSync(dst)) {
    if (lstatSync(dst).isSymbolicLink()) { report.skipped.push({ path: rel, why: "destination is a symlink" }); return; }
    if (mtime(dst) > mtime(src)) { report.skipped.push({ path: rel, why: "destination is newer than its source" }); return; }
  }
  invariant(within(toRoot, dst), `MoveCursors writes only inside ${toRoot}: ${dst}`);
  report.copied.push(rel);
  if (report.dry_run) return;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const s = statSync(src);
  utimesSync(dst, s.atime, s.mtime);
}

/** Every regular file under `dir` (recursive), symlinks skipped. */
function files(dir: string, keep: (name: string) => boolean = () => true): string[] {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name), st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...files(p, keep));
    else if (st.isFile() && keep(name)) out.push(p);
  }
  return out;
}

/** Copy `cursors/*.json` and `inbox/**` from one root to the other. */
function copyState(from: string, to: string, report: MoveReport): void {
  for (const src of files(join(from, "cursors"), (n) => n.endsWith(".json")).filter((p) => dirname(p) === join(from, "cursors"))) copyOne(src, join(to, "cursors", relative(join(from, "cursors"), src)), to, report);
  for (const src of files(join(from, "inbox"))) copyOne(src, join(to, "inbox", relative(join(from, "inbox"), src)), to, report);
}

/** Write a small JSON file unless the destination is newer than `source`. */
function seedJson(dst: string, value: unknown, source: string, root: string, report: MoveReport): boolean {
  if (existsSync(dst) && mtime(dst) > mtime(source)) { report.skipped.push({ path: relative(root, dst), why: "destination is newer than its source" }); return false; }
  invariant(within(root, dst), `MoveCursors writes only inside ${root}: ${dst}`);
  const body = JSON.stringify(value, null, 2) + "\n";
  invariant(body.length > 2, "seed JSON is nonempty");
  if (!report.dry_run) { mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, body); }
  return true;
}

function readSince(path: string): string | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as { since?: unknown };
    return typeof v.since === "string" ? v.since : null;
  } catch { return null; }
}

/** Old root → new root, with the cloud-pull and pulled-seed seeds. */
export function moveForward(opts: { dryRun?: boolean } = {}): MoveReport {
  const from = legacyRoot(), to = collectRoot();
  invariant(from !== to, `MoveCursors needs two different roots, got ${from} twice`);
  const report: MoveReport = { direction: "forward", from, to, dry_run: opts.dryRun === true, copied: [], skipped: [], seeded: {} };
  copyState(from, to, report);

  const storeReader = join(from, "store-reader.json"), since = readSince(storeReader);
  if (since !== null) {
    const stateRoot = resolve(statvsStateDir());
    if (seedJson(cloudPullPath(), { since, seeded_from: "store-reader.json" }, storeReader, stateRoot, report)) report.seeded.cloud_pull = since;
  }

  const pulled = join(from, "pulled.jsonl");
  if (existsSync(pulled)) {
    const ids = [...new Set(readFileSync(pulled, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { const id = (JSON.parse(line) as { id?: unknown }).id; return typeof id === "string" && id.length > 0 ? [id] : []; } catch { return []; }
    }))];
    if (seedJson(pulledSeedPath(), { ids, seeded_from: "pulled.jsonl" }, pulled, to, report)) report.seeded.pulled_seed = ids.length;
  }
  return report;
}

/** New root → old root, and `store-reader.json` from consumer `cloud-pull` (rollback, S5). */
export function moveBack(opts: { dryRun?: boolean } = {}): MoveReport {
  const from = collectRoot(), to = legacyRoot();
  invariant(from !== to, `MoveCursors needs two different roots, got ${from} twice`);
  const report: MoveReport = { direction: "back", from, to, dry_run: opts.dryRun === true, copied: [], skipped: [], seeded: {} };
  copyState(from, to, report);
  const pull = cloudPullPath(), since = readSince(pull);
  if (since !== null && seedJson(join(to, "store-reader.json"), { since }, pull, to, report)) report.seeded.store_reader = since;
  return report;
}

export function main(argv: string[]): number {
  const unknown = argv.filter((a) => a !== "--back" && a !== "--dry-run");
  if (unknown.length) { console.error(`usage: bun LIFEOS/STATVS/tools/MoveCursors.ts [--back] [--dry-run]  (unknown: ${unknown.join(" ")})`); return 2; }
  const dryRun = argv.includes("--dry-run");
  const report = argv.includes("--back") ? moveBack({ dryRun }) : moveForward({ dryRun });
  console.log(JSON.stringify(report, null, 2));
  for (const s of report.skipped) console.error(`MoveCursors skipped ${s.path}: ${s.why}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
