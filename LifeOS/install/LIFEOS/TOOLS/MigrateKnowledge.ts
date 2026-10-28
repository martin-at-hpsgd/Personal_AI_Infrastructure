#!/usr/bin/env bun
/**
 * @version 1.0.3
 * MigrateKnowledge — one-time (idempotent) migration of the Knowledge Archive
 * onto the kb-v3 Core Envelope (see KnowledgeSchema.ts + the design doc).
 *
 * SAFETY RAILS (the cross-vendor audit rightly called a bulk rewrite non-trivial):
 *   1. Dry-run by DEFAULT. Writes nothing without `--apply`.
 *   2. Body-byte preservation ENFORCED per note — if the transformed output's body
 *      slice isn't byte-identical to the original, that note ERRORS and is skipped
 *      (never written). Blog bodies contain literal `---`; we never re-serialize them.
 *   3. Deterministic ids (KnowledgeSchema.mintId) → re-run mints the SAME id, and
 *      already-kb-v3 notes are skipped, so the migration is idempotent.
 *   4. Atomic per-file write (tmp + rename).
 *   5. Reports before/after conformance so a wrong trim is visible.
 *   Git is the outer rollback: commit a checkpoint before `--apply`.
 *
 * `related` stays keyed on `slug` this pass (wikilinks + KnowledgeGraph.ts use slugs);
 * `id` is added as the future rename-safe anchor. The slug→id link cutover is a
 * separate, later migration.
 *
 * CLI:
 *   bun MigrateKnowledge.ts                 # dry-run over the whole archive
 *   bun MigrateKnowledge.ts --sample 3      # dry-run + 3 full before/after frontmatter diffs
 *   bun MigrateKnowledge.ts --dir Research  # limit to one dir
 *   bun MigrateKnowledge.ts --apply         # WRITE (after a git checkpoint)
 */

import { readdirSync, readFileSync, renameSync, existsSync, lstatSync, realpathSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, constants as fsConstants } from "node:fs";
import { resolve as pathResolve, join as pathJoin, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { invariant } from "./Invariant.ts";
import {
  parseNote, serializeNote, normalize, validate,
  DIR_TO_TYPE, slugFromPath, type CanonicalType,
} from "./KnowledgeSchema";
import { userDataRoot } from "./lib/ForeignDataCheck";

// Resolved through the one USER_DATA resolver rather than a hardcoded
// `~/.claude/LIFEOS/MEMORY` literal, which only worked because that path happens
// to be a symlink on the author's machine and silently migrated nothing anywhere
// else (public issue #1882, @jacobo-ortiz, @CarbonRaven, @xg-gh-25).
const KNOWLEDGE_DIR = pathResolve(userDataRoot(), "MEMORY", "KNOWLEDGE");
const DIRS = ["People", "Companies", "Ideas", "Research", "Blogs"] as const;

interface NoteOutcome {
  path: string;
  dir: string;
  status: "migrated" | "skipped-current" | "error-body" | "error-parse";
  changes: string[];
  residualViolations: number;
}

/** True only for one of the archive's known directories; `--dir` is an enum, never a path. */
export function isKnowledgeDir(dir: unknown): dir is (typeof DIRS)[number] {
  return typeof dir === "string" && (DIRS as readonly string[]).includes(dir);
}

/**
 * The migratable notes in one archive directory. The directory must be a known DIRS entry whose real path
 * sits directly under the real archive root, and each note must be a regular file (never a symlink) whose
 * real path sits in that directory, so neither `--dir` nor a planted link can reach outside the archive.
 */
export function listNotes(dir: string, root: string = KNOWLEDGE_DIR): string[] {
  if (!isKnowledgeDir(dir)) throw new Error(`--dir must be one of ${DIRS.join(", ")}, not ${JSON.stringify(dir)}`);
  const abs = pathJoin(root, dir);
  if (!existsSync(abs)) return [];
  const realRoot = realpathSync(root);
  const realDir = realpathSync(abs);
  if (realDir !== pathJoin(realRoot, dir)) throw new Error(`${abs} resolves outside the knowledge archive (${realDir})`);
  const out: string[] = [];
  for (const f of readdirSync(abs)) {
    if (!f.endsWith(".md") || f.startsWith("_") || f === "README.md") continue;
    const p = pathJoin(abs, f);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) continue; // a link or special file is never rewritten
    if (dirname(realpathSync(p)) !== realDir) continue;
    out.push(p);
  }
  return out;
}

/**
 * Replace `path` with `output` atomically, through a temp file this call creates exclusively (O_EXCL,
 * O_NOFOLLOW, unpredictable name) and writes through its own descriptor, so a pre-planted file or link at
 * a predictable temp path can never redirect the write. The original's permission
 * bits carry over, and the rename happens only when the target is still a regular file.
 */
export function replaceFileAtomic(path: string, output: string): void {
  const before = lstatSync(path);
  invariant(before.isFile() && !before.isSymbolicLink(), `MigrateKnowledge: ${path} must be a regular file to rewrite`);
  const tmp = `${path}.migrate.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, before.mode & 0o777);
  let renamed = false;
  try {
    try { writeSync(fd, output); fsyncSync(fd); } finally { closeSync(fd); }
    const now = lstatSync(path);
    invariant(now.isFile() && !now.isSymbolicLink() && now.ino === before.ino, `MigrateKnowledge: ${path} changed under the migration`);
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) { try { unlinkSync(tmp); } catch { /* already gone */ } }
  }
}

function migrateOne(path: string, dir: string, apply: boolean): NoteOutcome {
  const dirType = DIR_TO_TYPE[dir] as CanonicalType;
  const slug = slugFromPath(path);
  const original = readFileSync(path, "utf8");
  const parsed = parseNote(original);
  if (!parsed.hadFrontmatter || parsed.malformed) {
    // No frontmatter, OR a leading `---…---` that isn't real YAML (orphan content
    // line). Rewriting would silently drop that content — skip, don't touch.
    return { path, dir, status: "error-parse", changes: [], residualViolations: 0 };
  }
  const norm = normalize(parsed, slug, dirType);
  if (norm.alreadyCurrent) {
    return { path, dir, status: "skipped-current", changes: [], residualViolations: 0 };
  }
  const output = serializeNote(norm.fields, parsed.body);

  // RAIL 2: body-byte preservation. The body (from the closing `---` on) must be
  // byte-identical. Since serializeNote appends parsed.body verbatim, this is a
  // guard against any future parse regression — cheap, absolute.
  if (!output.endsWith(parsed.body)) {
    return { path, dir, status: "error-body", changes: norm.changes, residualViolations: 0 };
  }

  const residual = validate(parseNote(output), slug, dirType).length;

  if (apply) replaceFileAtomic(path, output);
  return { path, dir, status: "migrated", changes: norm.changes, residualViolations: residual };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const sampleIdx = args.indexOf("--sample");
  const sampleN = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1] || "0", 10) : 0;
  const dirIdx = args.indexOf("--dir");
  const onlyDir = dirIdx >= 0 ? args[dirIdx + 1] : null;

  if (dirIdx >= 0 && !isKnowledgeDir(onlyDir)) {
    console.error(`[MigrateKnowledge] --dir must be one of ${DIRS.join(", ")}, not ${JSON.stringify(onlyDir)}`);
    process.exit(2);
  }
  const dirs: string[] = onlyDir ? [onlyDir] : [...DIRS];
  const outcomes: NoteOutcome[] = [];
  const changeHistogram = new Map<string, number>();
  const samples: { path: string; before: string; after: string }[] = [];

  for (const dir of dirs) {
    for (const path of listNotes(dir)) {
      const o = migrateOne(path, dir, apply);
      outcomes.push(o);
      for (const c of o.changes) {
        // Bucket changes by their rule (strip the specific value after `:`)
        const bucket = c.replace(/:.*/, "").replace(/\d[\w.-]*/g, "N").trim();
        changeHistogram.set(bucket, (changeHistogram.get(bucket) ?? 0) + 1);
      }
      if (samples.length < sampleN && o.status === "migrated") {
        // Dry-run only shows before/after; after --apply the file is already the
        // migrated form (the diff is in git), so just point there.
        const cur = parseNote(readFileSync(path, "utf8"));
        samples.push({
          path: path.replace(KNOWLEDGE_DIR + "/", ""),
          before: apply ? "(applied — see git diff)" : cur.fields.map((f) => f.raw).join("\n"),
          after: normalize(cur, slugFromPath(path), DIR_TO_TYPE[o.dir] as CanonicalType).fields.map((f) => f.raw).join("\n"),
        });
      }
    }
  }

  const by = (s: NoteOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const total = outcomes.length;
  const migrated = by("migrated");
  const skipped = by("skipped-current");
  const errBody = by("error-body");
  const errParse = by("error-parse");
  const residualNotes = outcomes.filter((o) => o.residualViolations > 0).length;

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  MigrateKnowledge — ${apply ? "APPLY (files written)" : "DRY-RUN (nothing written)"}`);
  console.log(`${"=".repeat(64)}`);
  console.log(`  Total notes scanned:      ${total}`);
  console.log(`  Would migrate / migrated: ${migrated}`);
  console.log(`  Skipped (already kb-v3):  ${skipped}`);
  console.log(`  ERROR body-mismatch:      ${errBody}   ${errBody ? "⚠️ NOT written" : "✓"}`);
  console.log(`  ERROR no-frontmatter:     ${errParse}  ${errParse ? "⚠️" : "✓"}`);
  console.log(`  Migrated-but-residual:    ${residualNotes}  (still miss an optional per-type field, e.g. research source_url)`);

  console.log(`\n  Per-dir:`);
  for (const dir of dirs) {
    const dd = outcomes.filter((o) => o.dir === dir);
    console.log(`    ${dir.padEnd(11)} ${dd.length} notes · migrate ${dd.filter((o) => o.status === "migrated").length} · skip ${dd.filter((o) => o.status === "skipped-current").length} · errBody ${dd.filter((o) => o.status === "error-body").length}`);
  }

  console.log(`\n  Change types (how many notes each rule touched):`);
  for (const [bucket, n] of [...changeHistogram.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${bucket}`);
  }

  if (errBody > 0) {
    console.log(`\n  ⚠️ BODY-MISMATCH notes (skipped, need manual look):`);
    for (const o of outcomes.filter((x) => x.status === "error-body").slice(0, 20)) {
      console.log(`    ${o.path.replace(KNOWLEDGE_DIR + "/", "")}`);
    }
  }

  for (const s of samples) {
    console.log(`\n  ${"-".repeat(60)}\n  SAMPLE: ${s.path}\n  --- BEFORE ---\n${s.before.split("\n").map((l) => "    " + l).join("\n")}\n  --- AFTER ----\n${s.after.split("\n").map((l) => "    " + l).join("\n")}`);
  }

  if (!apply) console.log(`\n  Dry-run only. Re-run with --apply (after a git checkpoint) to write.\n`);
  else console.log(`\n  ✓ Applied. Verify with: bun LIFEOS/TOOLS/KnowledgeLint.ts\n`);

  process.exit(errParse > 0 || errBody > 0 ? 1 : 0);
}

if (import.meta.main) main();
