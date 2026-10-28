#!/usr/bin/env bun
/**
 * @version 1.2.6
 * MemoryRestore — recover a hot-layer memory file from the per-write snapshot
 * ring that MemoryWriter maintains. set-overwrite has a whole-file blast radius;
 * this is the individual-write undo that git (commit-granularity) can't give.
 *
 *   bun MemoryRestore.ts list [principal|da]      — list snapshots, newest last
 *   bun MemoryRestore.ts restore <snapshot-file>  — byte-exact restore to target
 *   bun MemoryRestore.ts latest principal         — restore the newest snapshot
 *
 * Restore is a raw byte copy (frontmatter + entries + markers), so it cannot
 * itself trip the curation guards — it's a recovery path, not a curation write.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { parseMemoryContent, restoreContent } from "./MemoryWriter";
import { getClaudeDir } from "./Paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep

const CLAUDE_ROOT = getClaudeDir();
const SNAPSHOT_DIR = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/memory-snapshots");
const TARGETS: Record<string, string> = {
  principal: pathResolve(CLAUDE_ROOT, "LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md"),
  da: pathResolve(CLAUDE_ROOT, "LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md"),
};
const BASE: Record<string, string> = { principal: "PRINCIPAL_MEMORY", da: "DA_MEMORY" };

function snapshotsFor(which: string): string[] {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  return readdirSync(SNAPSHOT_DIR)
    .filter((f: string) => f.startsWith(`${BASE[which]}__`))
    .sort();
}

function countEntries(content: string): number {
  // Shared lenient parser — the old lazy regex read 0 on any marker-corrupted
  // snapshot, so the restore picker showed real snapshots as empty and made the
  // recovery path itself untrustworthy. (public PR #1593, @anikinsasha)
  return parseMemoryContent(content).entries.length;
}

/** A snapshot filename exactly as MemoryWriter writes it: `<BASE>__<ISO stamp with : and . as ->.md`. */
const SNAPSHOT_NAME = /^(PRINCIPAL_MEMORY|DA_MEMORY)__[0-9T-]+Z\.md$/;

export type SnapshotResolution =
  | { ok: true; path: string; which: "principal" | "da" }
  | { ok: false; error: string };

/**
 * Resolve a restore argument to one file inside the snapshot ring, or refuse. The argument must be a bare
 * snapshot filename (no directory part, no absolute path, no traversal), and the file's real path must sit
 * directly in the real snapshot dir, so a link in the ring cannot hand restoreContent outside content
 *. The snapshot itself must be a regular file reached without a symlink.
 */
export function resolveSnapshot(arg: string, snapshotDir: string = SNAPSHOT_DIR): SnapshotResolution {
  if (typeof arg !== "string" || !SNAPSHOT_NAME.test(arg)) {
    return { ok: false, error: `not a snapshot filename: ${JSON.stringify(arg)} (expected PRINCIPAL_MEMORY__<stamp>.md or DA_MEMORY__<stamp>.md)` };
  }
  let realDir: string;
  try { realDir = realpathSync(snapshotDir); } catch { return { ok: false, error: `snapshot dir not found: ${snapshotDir}` }; }
  const candidate = pathResolve(realDir, arg);
  let st;
  try { st = lstatSync(candidate); } catch { return { ok: false, error: `Snapshot not found: ${arg}` }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: `snapshot is not a regular file: ${arg}` };
  let real: string;
  try { real = realpathSync(candidate); } catch { return { ok: false, error: `Snapshot not found: ${arg}` }; }
  if (dirname(real) !== realDir) return { ok: false, error: `snapshot resolves outside the snapshot ring: ${arg}` };
  return { ok: true, path: real, which: arg.startsWith("PRINCIPAL_MEMORY__") ? "principal" : "da" };
}

function main(): void {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === "list") {
    for (const which of arg ? [arg] : ["principal", "da"]) {
      const snaps = snapshotsFor(which);
      console.log(`\n${which} (${snaps.length} snapshots):`);
      for (const s of snaps) {
        const n = countEntries(readFileSync(pathResolve(SNAPSHOT_DIR, s), "utf8"));
        console.log(`  ${s}  [${n} entries]`);
      }
    }
    return;
  }

  if (cmd === "restore" && arg) {
    const resolved = resolveSnapshot(arg);
    if (!resolved.ok) { console.error(resolved.error); process.exit(1); }
    const which = resolved.which;
    const content = readFileSync(resolved.path, "utf8");
    // git cannot track an empty dir, so the target's parent is absent on a fresh clone (public PR #2030, @abseg)
    mkdirSync(dirname(TARGETS[which]), { recursive: true });
    const r = restoreContent(TARGETS[which], content, { updatedBy: "MemoryRestore", snapshotRef: arg });
    if (!r.ok) { console.error(`Restore failed (${r.code}): ${r.message}`); process.exit(1); }
    console.log(`Restored ${which} from ${arg} (${countEntries(content)} entries).`);
    return;
  }

  if (cmd === "latest" && arg) {
    if (!(arg in TARGETS)) { console.error(`latest takes principal or da, not ${JSON.stringify(arg)}`); process.exit(2); }
    const snaps = snapshotsFor(arg).filter((s) => SNAPSHOT_NAME.test(s));
    if (snaps.length === 0) { console.error(`No snapshots for ${arg}`); process.exit(1); }
    const latest = snaps[snaps.length - 1]!;
    const resolved = resolveSnapshot(latest);
    if (!resolved.ok) { console.error(resolved.error); process.exit(1); }
    const content = readFileSync(resolved.path, "utf8");
    mkdirSync(dirname(TARGETS[arg]), { recursive: true }); // public PR #2030, @abseg
    const r = restoreContent(TARGETS[arg], content, { updatedBy: "MemoryRestore", snapshotRef: latest });
    if (!r.ok) { console.error(`Restore failed (${r.code}): ${r.message}`); process.exit(1); }
    console.log(`Restored ${arg} from latest snapshot ${latest} (${countEntries(content)} entries).`);
    return;
  }

  console.error("Usage: bun MemoryRestore.ts {list [principal|da] | restore <snapshot-file> | latest <principal|da>}");
  process.exit(2);
}

if (import.meta.main) main();
