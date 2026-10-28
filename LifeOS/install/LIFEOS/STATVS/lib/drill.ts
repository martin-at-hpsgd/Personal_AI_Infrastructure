/**
 * STATVS drill — the proof that STATE can be deleted and rebuilt from the record.
 *
 * 1. Copy the record to a temp dir (`cp -c -R`, an APFS clone; fs.cpSync if that fails).
 * 2. Rebuild every registered view into a temp STATE dir from the copy. A view with a
 *    trustworthy live checkpoint is rebuilt exactly as far as that checkpoint reached, so a
 *    view that is merely behind the record is not counted as lost.
 * 3. Compare each rebuilt output with the live file, as canonical JSON.
 * 4. Walk the live STATE tree and count the files no view claims, by top-level folder.
 * 5. loss = views not equal + unclaimed files. A view never materialized (no live output file and
 *    no checkpoint file: a view registered since the last read) is reported in `unmaterialized`,
 *    never as lost, since nothing it held can be missing. A live output that exists and differs, or
 *    a checkpoint file whose output is gone, still counts as lost, and that holds for a checkpoint
 *    file that is corrupt or fails validation too: its presence proves the view was written.
 *
 * The drill reads the live record and the live STATE tree and never writes to either
 * (ISC-60). Its only write is one result row appended to the record (stream statvs, kind
 * drill), skipped with `record: false`. The temp dir is removed before it returns.
 *
 * @version 1.1.1
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { invariant } from "../../TOOLS/Invariant";
import { append, counters, scan, statvsDir } from "./record";
import type { Counters } from "./types";
import { checkpointRel, comparable, loadViews, rebuildDef, snapshotView, viewsDir } from "./views";

export interface DrillView {
  name: string;
  group?: string;
  equal: boolean;
  /** True when the view has never been written live (no output, no checkpoint). Not loss; `equal` is false. */
  unmaterialized?: boolean;
  /** "checkpoint": rebuilt up to the live checkpoint; "full": no usable checkpoint, rebuilt from everything. */
  mode: "checkpoint" | "full";
  rows: number;
  reason?: string;
}

export interface DrillResult {
  loss: number;
  views: DrillView[];
  /** Views with no live output and no checkpoint yet (newly registered); not counted in loss. */
  unmaterialized: string[];
  unclaimed: number;
  unclaimed_by_dir: Record<string, number>;
  /** Counter movement since the previous recorded drill (the drill's window). */
  refused: number;
  spooled: number;
  quarantined: number;
  counters_total: Counters;
  registry_problems: string[];
  scan_problems: number;
  record_bytes_copied: number;
  recorded: boolean;
  record_result?: string;
}

export interface DrillOptions {
  /** Append the result row to the record (default true). */
  record?: boolean;
  recordDir?: string;
  viewsDir?: string;
  src?: string;
}

function copyRecord(src: string, dst: string): void {
  const s = resolve(src), d = resolve(dst);
  invariant(d !== s && !d.startsWith(s + "/") && !s.startsWith(d + "/"), "the drill copy must never overlap the record it copies");
  if (!existsSync(src)) { mkdirSync(dst, { recursive: true }); return; }
  try {
    execFileSync("cp", ["-c", "-R", src, dst], { stdio: "ignore" });
  } catch {
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
  }
}

function sizeOf(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n += statSync(p).size;
    }
  };
  try { walk(dir); } catch { /* best-effort figure */ }
  return n;
}

/** Every file under root, relative, without following symlinks (a symlink counts as one file). */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(root, "");
  return out;
}

/** True when anything sits at the path (lstat, so a dangling symlink or a corrupt file counts). */
function entryExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/** A file is claimed when it is a view's output or checkpoint, or a lock or temp file beside one. */
function isClaimed(rel: string, claimed: Set<string>): boolean {
  if (claimed.has(rel)) return true;
  const base = rel.replace(/\.lock$/, "").replace(/\.tmp-[^/]*$/, "");
  return base !== rel && claimed.has(base);
}

function lastDrillCounters(recordDir: string): Counters | null {
  const { rows } = scan({ dir: recordDir, streams: ["statvs"], classes: ["system"] });
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind !== "drill") continue;
    const c = (r.data as { counters_total?: Counters } | null)?.counters_total;
    if (c && typeof c.refused === "number") return c;
  }
  return null;
}

export async function drill(opts: DrillOptions = {}): Promise<DrillResult> {
  const recordDir = resolve(opts.recordDir ?? statvsDir());
  const live = resolve(opts.viewsDir ?? viewsDir());
  const tmp = mkdtempSync(join(tmpdir(), "statvs-drill-"));
  invariant(!tmp.startsWith(recordDir) && !tmp.startsWith(live), "the drill's temp dir must sit outside the live record and STATE");
  try {
    const copy = join(tmp, "record");
    const rebuilt = join(tmp, "state");
    const reg = await loadViews(opts.src);
    // Each view's checkpoint offsets and output are read together under its lock, BEFORE the
    // record is copied: the record only grows, so the copy holds every row the checkpoint
    // covers, and a view read during the drill cannot move one side of the pair (no false loss).
    // Whether a checkpoint FILE exists is judged apart from whether it parsed: a corrupt or invalid
    // checkpoint still proves the view was written. It is looked at before and after the locked
    // snapshot, and counts only when present both times (or when the snapshot parsed it), so a view
    // first written while the drill runs is never read as a checkpoint whose output is gone.
    const snaps = new Map(reg.views.map((def) => {
      const cpPath = join(live, checkpointRel(def.name));
      const before = entryExists(cpPath);
      const snap = snapshotView(def, live);
      const checkpointFile = snap.offsets !== null || (before && entryExists(cpPath));
      return [def.name, { ...snap, checkpointFile }] as const;
    }));
    copyRecord(recordDir, copy);
    mkdirSync(rebuilt, { recursive: true });

    const views: DrillView[] = [];
    const claimed = new Set<string>();
    for (const def of reg.views) {
      claimed.add(def.path);
      claimed.add(checkpointRel(def.name));
      const snap = snaps.get(def.name)!;
      const until = snap.offsets;
      const mode: DrillView["mode"] = until ? "checkpoint" : "full";
      let res;
      try {
        res = rebuildDef(def, { recordDir: copy, outDir: rebuilt, until: until ?? undefined });
      } catch (e) {
        views.push({ name: def.name, group: def.group, equal: false, mode, rows: 0, reason: `rebuild failed: ${(e as Error).message}` });
        continue;
      }
      const liveText = snap.text;
      if (liveText === null) {
        // No output file and no checkpoint file: the view was never read on this tree. A checkpoint
        // file without its output, valid or not, means the output was lost.
        const never = !snap.checkpointFile;
        const missing = until === null ? "live file missing; checkpoint corrupt or invalid" : "live file missing";
        views.push({ name: def.name, group: def.group, equal: false, mode, rows: res.rows, ...(never ? { unmaterialized: true, reason: "never materialized" } : { reason: missing }) });
        continue;
      }
      const equal = comparable(liveText) === res.canonical;
      views.push({ name: def.name, group: def.group, equal, mode, rows: res.rows, ...(equal ? {} : { reason: "rebuilt output differs from the live file" }) });
    }

    const unclaimedFiles = walkFiles(live).filter((r) => !isClaimed(r, claimed));
    const byDir: Record<string, number> = {};
    for (const f of unclaimedFiles) {
      const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : ".";
      byDir[top] = (byDir[top] ?? 0) + 1;
    }

    const total = counters();
    const prev = lastDrillCounters(copy);
    const delta = (k: keyof Counters) => Math.max(0, total[k] - (prev?.[k] ?? 0));
    const scanProblems = scan({ dir: copy }).problems?.length ?? 0;

    const unmaterialized = views.filter((v) => v.unmaterialized === true).map((v) => v.name);
    const lost = views.filter((v) => !v.equal && v.unmaterialized !== true);
    const notEqual = lost.length;
    const result: DrillResult = {
      loss: notEqual + unclaimedFiles.length,
      views,
      unmaterialized,
      unclaimed: unclaimedFiles.length,
      unclaimed_by_dir: byDir,
      refused: delta("refused"),
      spooled: delta("spooled"),
      quarantined: delta("quarantined"),
      counters_total: total,
      registry_problems: reg.problems,
      scan_problems: scanProblems,
      record_bytes_copied: sizeOf(copy),
      recorded: false,
    };

    if (opts.record !== false) {
      const r = append({
        writer: "statvs-drill", stream: "statvs", class: "system", kind: "drill",
        severity: result.loss > 0 ? "low" : "info",
        title: `Drill loss ${result.loss}`,
        data: {
          loss: result.loss,
          views_total: views.length,
          views_equal: views.length - notEqual - unmaterialized.length,
          views_unequal: lost.map((v) => v.name),
          views_unmaterialized: unmaterialized,
          unclaimed: result.unclaimed,
          unclaimed_by_dir: byDir,
          refused: result.refused, spooled: result.spooled, quarantined: result.quarantined,
          counters_total: total,
        },
      });
      result.recorded = r.ok;
      if (!r.ok) result.record_result = "refused" in r ? `refused: ${r.refused}` : `spooled: ${r.reason}`;
    }
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
