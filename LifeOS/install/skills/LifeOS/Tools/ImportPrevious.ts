#!/usr/bin/env bun
/**
 * ImportPrevious — bring USER data from an earlier LifeOS install, or a backup of one, into this install's
 * USER tree. Fills missing files only, never overwrites, and lists every conflict so the adopter's agent
 * can offer the principal a choice.
 *
 *   bun Tools/ImportPrevious.ts --from <dir>                  # dry run: what would be copied, nothing written
 *   bun Tools/ImportPrevious.ts --from <dir> --apply          # copy the missing files
 *   bun Tools/ImportPrevious.ts --from <dir> --json           # the report as JSON (for the agent)
 *
 * Why it exists (installer ISA F8, ISC-31/32; principal 2026-10-14, "possibly importing previous data over"):
 * a v7 user moving to 8.x had no designed way to carry their USER tree, their memory and their keys into a
 * fresh install, so they copied directories by hand and either clobbered the new templates or lost files.
 *
 * Source shapes it recognises (`--from`):
 *  - `config-root`      an old harness root (`~/.claude` or a copy) whose `LIFEOS/USER` is either a real
 *                       directory (in-tree, before the 2026-05 user separation) or a symlink into the data home
 *                       (`~/.config/LIFEOS/USER`, v7.40.4). A real `LIFEOS/MEMORY` directory beside it is the
 *                       pre-separation memory and lands in `USER/MEMORY`.
 *  - `pai-config-root`  the same, from the PAI era (`PAI/USER`, `PAI/MEMORY`).
 *  - `data-home`        an old data home (`~/.config/LIFEOS` or a copy) holding `USER/`.
 *  - `user-tree`        a copy of a USER tree itself (including a `USER.pre-link-backup-<stamp>` directory).
 *
 * Secrets: no secret value is ever printed. The env parser returns key NAMES only, so values never reach
 * the report. An old `.env` is carried only when this install has none, written at mode 0600 with O_EXCL;
 * otherwise the report lists the key names the old file has and the new one lacks, and points at
 * `bun LIFEOS/TOOLS/Secrets.ts set <KEY>` (echo off, never argv).
 *
 * Harness state is never imported: transcripts and `projects/`, caches, `node_modules`, `.git`, session and
 * runtime state, OS junk, symlinks and special files are skipped and counted by category.
 *
 * Imports stay inside the skill: this runs from the install skill, which must not depend on LIFEOS/TOOLS.
 */

import {
  chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fchmodSync, lstatSync, mkdirSync,
  openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, utimesSync, writeSync, type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findDevWriteViolation } from "./InstallEngine";

class InvariantViolation extends Error { constructor(m: string) { super(`invariant violated: ${m}`); this.name = "InvariantViolation"; } }
function invariant(cond: unknown, msg: string): asserts cond { if (!cond) throw new InvariantViolation(msg); }

// ── Types ────────────────────────────────────────────────────────────

export type SourceShape = "config-root" | "pai-config-root" | "data-home" | "user-tree";
export type SkipCategory =
  | "transcripts" | "harness-state" | "caches" | "dependencies" | "vcs" | "runtime-state" | "os-junk" | "symlinks" | "special-files"
  | "shadowed";
export type ConflictKind = "content" | "type" | "symlink";
export type EnvAction = "copied" | "would-copy" | "kept-existing" | "none-found";

export interface Conflict {
  /** Path relative to the USER tree root. */
  path: string;
  kind: ConflictKind;
  /** Size of the old file in bytes. */
  fromBytes: number;
  /** Size of what sits at the path in this install (0 for a directory or a symlink). */
  toBytes: number;
  /** True when this install's file is still the untouched shipped template, so taking the old one loses nothing. */
  destIsTemplate: boolean;
}

export interface EnvReport {
  /** The old env file that was read for key names (path only). */
  found: string | null;
  action: EnvAction;
  /** Key names with a value in the old file that this install lacks or has empty. Names only. */
  keysMissing: string[];
  instructions: string | null;
}

export interface ImportReport {
  ok: boolean;
  dryRun: boolean;
  from: {
    path: string;
    shape: SourceShape | null;
    /** For a config root: whether its USER was a real directory or a link into a data home. */
    layout: "in-tree" | "linked" | null;
    userTree: string | null;
    /** A pre-separation memory directory imported into USER/MEMORY, when one was found. */
    memoryTree: string | null;
    version: string | null;
  };
  to: { configRoot: string; userTree: string | null; envFile: string };
  counts: { copied: number; identical: number; conflicts: number; skipped: number; failed: number };
  /** Files copied (or, in a dry run, files that would be). Capped at COPIED_LIST_CAP; `copiedTruncated` says how many more. */
  copied: string[];
  copiedTruncated: number;
  conflicts: Conflict[];
  skipped: Partial<Record<SkipCategory, { count: number; examples: string[] }>>;
  failures: Array<{ path: string; error: string }>;
  env: EnvReport;
  /** Further sources found beside the one imported (earlier pre-link backups), for a second run. */
  otherCandidates: string[];
  /** User-authored `_NAME` skills in the old root that this install lacks; not imported, listed for review. */
  privateSkillsNotImported: string[];
  next: string;
  error?: string;
  refused?: "dev-tree";
}

export interface ImportOpts {
  from: string;
  configRoot: string;
  apply: boolean;
  allowDev?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

export const COPIED_LIST_CAP = 500;
const EXAMPLES_PER_CATEGORY = 5;

/** Names a USER tree carries (v7.x and the PAI era). One strong marker is enough to recognise one. */
const USER_MARKERS: readonly string[] = [
  "PRINCIPAL", "DIGITAL_ASSISTANT", "TELOS", "CONFIG", "PROJECTS.md", "CONTACTS.md", "CUSTOMIZATIONS",
  "DEFINITIONS.md", "DAIDENTITY.md", "ABOUTME.md",
];

/** Top-level entries of a harness root that are harness state, reported (never walked) when the source is a config root. */
const HARNESS_ROOT_STATE: Readonly<Record<string, SkipCategory>> = {
  projects: "transcripts", transcripts: "transcripts",
  todos: "harness-state", "shell-snapshots": "harness-state", statsig: "harness-state", "file-history": "harness-state",
  "session-env": "harness-state", ide: "harness-state", debug: "harness-state", plugins: "harness-state",
  cache: "caches", "paste-cache": "caches",
};

const DIR_SKIPS: Readonly<Record<string, SkipCategory>> = {
  ".git": "vcs", node_modules: "dependencies",
  projects: "transcripts", transcripts: "transcripts",
  cache: "caches", ".cache": "caches", CACHE: "caches", "paste-cache": "caches", _embeddings: "caches",
  "session-env": "runtime-state", "shell-snapshots": "runtime-state", todos: "runtime-state",
};

const FILE_SKIPS: Readonly<Record<string, SkipCategory>> = { ".DS_Store": "os-junk", "Thumbs.db": "os-junk" };

/** A file that holds secrets by its name: written at 0600 whatever its old mode was. */
export function isSecretFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || name === ".credentials.json";
}

function dirSkipCategory(name: string, relPath: string): SkipCategory | null {
  if (DIR_SKIPS[name]) return DIR_SKIPS[name]!;
  if (/[-.]cache$/i.test(name)) return "caches";
  if (name.includes(".pre-link-backup-")) return null; // a nested backup is user data; it is walked like any directory
  // Memory's runtime state (locks, current-session markers) is regenerated by the new install.
  if (relPath === join("MEMORY", "STATE")) return "runtime-state";
  return null;
}

function fileSkipCategory(name: string): SkipCategory | null {
  if (FILE_SKIPS[name]) return FILE_SKIPS[name]!;
  if (/\.(lock|pid|sock)$/i.test(name)) return "runtime-state";
  if (/(\.cache|-cache\.json)$/i.test(name)) return "caches";
  return null;
}

// ── Path helpers ─────────────────────────────────────────────────────

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

function realOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

function lstatOrNull(p: string): Stats | null {
  return lstatSync(p, { throwIfNoEntry: false }) ?? null;
}

function isRealDir(p: string): boolean {
  return lstatOrNull(p)?.isDirectory() === true;
}

/** A directory (following a symlink) that carries at least one USER marker. */
export function looksLikeUserTree(dir: string): boolean {
  const real = realOrNull(dir);
  if (!real || !statSync(real).isDirectory()) return false;
  return USER_MARKERS.some((m) => existsSync(join(real, m)));
}

// ── Env parsing (names only) ─────────────────────────────────────────

/**
 * Key names in an env file, and whether each carries a non-empty value. Values never leave this function:
 * that is the structural guarantee that no report can print one.
 */
export function envKeyNames(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      const q = v[0]!;
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash);
      if (v.startsWith("#")) v = "";
    }
    const has = v.trim().length > 0;
    out.set(m[1]!, (out.get(m[1]!) ?? false) || has);
  }
  return out;
}

// ── Source detection ─────────────────────────────────────────────────

interface Source {
  shape: SourceShape;
  layout: "in-tree" | "linked" | null;
  root: string;
  userTree: string;
  memoryTree: string | null;
  envCandidates: string[];
  version: string | null;
  harnessRoot: string | null;
}

type Detected = { ok: true; source: Source } | { ok: false; error: string };

function readVersion(p: string): string | null {
  try { const v = readFileSync(p, "utf8").trim(); return /^\d+\.\d+\.\d+/.test(v) ? v.split(/\s/)[0]! : null; } catch { return null; }
}

export function detectSource(fromArg: string): Detected {
  const root = realOrNull(fromArg);
  if (!root) return { ok: false, error: `--from ${fromArg} does not exist` };
  if (!statSync(root).isDirectory()) return { ok: false, error: `--from ${fromArg} is not a directory` };

  for (const [dir, shape] of [["LIFEOS", "config-root"], ["PAI", "pai-config-root"]] as const) {
    const userLink = join(root, dir, "USER");
    const st = lstatOrNull(userLink);
    if (!st) continue;
    let userTree: string;
    let layout: "in-tree" | "linked";
    if (st.isSymbolicLink()) {
      const target = realOrNull(userLink);
      if (!target) {
        let dest = "?";
        try { dest = readlinkSync(userLink); } catch { /* unreadable link */ }
        return { ok: false, error: `${userLink} is a link to ${dest}, which does not exist here. Pass --from the copy of that data home (the directory holding USER/) instead.` };
      }
      userTree = target;
      layout = "linked";
    } else if (st.isDirectory()) {
      userTree = userLink;
      layout = "in-tree";
    } else {
      return { ok: false, error: `${userLink} is neither a directory nor a link to one` };
    }
    const memPath = join(root, dir, "MEMORY");
    const memReal = realOrNull(memPath);
    // A memory directory that is not already inside the USER tree is the pre-separation memory.
    const memoryTree = memReal && statSync(memReal).isDirectory() && !isWithin(memReal, realpathSync(userTree)) ? memReal : null;
    const dataHome = layout === "linked" ? dirname(userTree) : null;
    const envCandidates = [join(root, ".env"), join(root, dir, ".env"), ...(dataHome ? [join(dataHome, ".env")] : [])];
    return {
      ok: true,
      source: {
        shape, layout, root, userTree: realpathSync(userTree), memoryTree, envCandidates,
        version: readVersion(join(root, dir, "VERSION")), harnessRoot: root,
      },
    };
  }

  if (looksLikeUserTree(join(root, "USER"))) {
    return {
      ok: true,
      source: {
        shape: "data-home", layout: null, root, userTree: realpathSync(join(root, "USER")), memoryTree: null,
        envCandidates: [join(root, ".env")], version: null, harnessRoot: null,
      },
    };
  }
  if (looksLikeUserTree(root)) {
    return {
      ok: true,
      source: { shape: "user-tree", layout: null, root, userTree: root, memoryTree: null, envCandidates: [join(root, ".env")], version: null, harnessRoot: null },
    };
  }
  return {
    ok: false,
    error: `${fromArg} is not a LifeOS install or backup: looked for LIFEOS/USER, PAI/USER, USER/ with LifeOS data, or a USER tree itself (one of ${USER_MARKERS.join(", ")}).`,
  };
}

// ── Planning ─────────────────────────────────────────────────────────

interface PlannedFile { src: string; rel: string; stat: Stats }

interface Plan {
  files: PlannedFile[];
  dirModes: Map<string, number>;
  skipped: Map<SkipCategory, { count: number; examples: string[] }>;
  /** Source directories that could not be read; reported as failures while the rest of the import goes on. */
  unreadable: Array<{ path: string; error: string }>;
}

function noteSkip(plan: Plan, cat: SkipCategory, example: string): void {
  const e = plan.skipped.get(cat) ?? { count: 0, examples: [] };
  e.count++;
  if (e.examples.length < EXAMPLES_PER_CATEGORY) e.examples.push(example);
  plan.skipped.set(cat, e);
}

/** Walk one source tree without following any link, mapping each regular file to a USER-relative path. */
function walkInto(plan: Plan, srcRoot: string, destPrefix: string, seen: Set<string>): void {
  const walk = (dir: string, relDir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) {
      plan.unreadable.push({ path: relDir || ".", error: `cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const src = join(dir, ent.name);
      const rel = relDir ? join(relDir, ent.name) : ent.name;
      const st = lstatSync(src);
      if (st.isSymbolicLink()) { noteSkip(plan, "symlinks", rel); continue; }
      if (st.isDirectory()) {
        const cat = dirSkipCategory(ent.name, rel);
        if (cat) { noteSkip(plan, cat, rel + sep); continue; }
        plan.dirModes.set(rel, st.mode & 0o777);
        walk(src, rel);
        continue;
      }
      if (!st.isFile()) { noteSkip(plan, "special-files", rel); continue; }
      const cat = fileSkipCategory(ent.name);
      if (cat) { noteSkip(plan, cat, rel); continue; }
      if (seen.has(rel)) { noteSkip(plan, "shadowed", rel); continue; } // an earlier source supplies this path; the first wins
      seen.add(rel);
      plan.files.push({ src, rel, stat: st });
    }
  };
  walk(srcRoot, destPrefix);
}

function buildPlan(source: Source): Plan {
  const plan: Plan = { files: [], dirModes: new Map(), skipped: new Map(), unreadable: [] };
  const seen = new Set<string>();
  walkInto(plan, source.userTree, "", seen);
  if (source.memoryTree) {
    plan.dirModes.set("MEMORY", statSync(source.memoryTree).mode & 0o777);
    walkInto(plan, source.memoryTree, "MEMORY", seen);
  }
  if (source.harnessRoot) {
    for (const name of Object.keys(HARNESS_ROOT_STATE).sort()) {
      if (lstatOrNull(join(source.harnessRoot, name))) noteSkip(plan, HARNESS_ROOT_STATE[name]!, name + sep);
    }
  }
  return plan;
}

// ── Destination writes ───────────────────────────────────────────────

type DirCheck = { state: "present" | "absent" } | { state: "blocked"; kind: ConflictKind; at: string };

/**
 * Walk (and on apply, create) the directories of `relDir` under the USER root one segment at a time, so no
 * write ever passes through a symlinked component or lands on a file standing where a directory belongs.
 */
function ensureDir(userRoot: string, relDir: string, dirModes: Map<string, number>, apply: boolean): DirCheck {
  let cur = userRoot;
  let rel = "";
  for (const seg of relDir.split(sep).filter(Boolean)) {
    invariant(seg !== "." && seg !== "..", `relative path segment ${seg} in ${relDir}`);
    cur = join(cur, seg);
    rel = rel ? join(rel, seg) : seg;
    const st = lstatOrNull(cur);
    if (!st) {
      if (!apply) return { state: "absent" };
      mkdirSync(cur, { mode: (dirModes.get(rel) ?? 0o700) | 0o700 });
      const real = realpathSync(cur);
      invariant(isWithin(real, userRoot), `created directory ${cur} resolves outside the USER tree (${real})`);
      continue;
    }
    if (st.isSymbolicLink()) return { state: "blocked", kind: "symlink", at: rel };
    if (!st.isDirectory()) return { state: "blocked", kind: "type", at: rel };
  }
  return { state: "present" };
}

function sameBytes(a: string, b: string, size: number): boolean {
  if (statSync(b).size !== size) return false;
  return Buffer.compare(readFileSync(a), readFileSync(b)) === 0;
}

function templateMatches(templateRoot: string | null, rel: string, dest: string): boolean {
  if (!templateRoot) return false;
  const tpl = join(templateRoot, rel);
  const st = lstatOrNull(tpl);
  if (!st?.isFile()) return false;
  try { return sameBytes(tpl, dest, st.size); } catch { return false; }
}

/** Write a file this install does not have. O_EXCL: if anything appeared at the path meanwhile, it throws. */
function copyNew(f: PlannedFile, dest: string, userRoot: string, sourceRoots: string[]): void {
  invariant(sourceRoots.some((r) => isWithin(f.src, r)), `source ${f.src} is outside the source trees`);
  invariant(lstatOrNull(dest) === null, `refusing to overwrite ${dest}`);
  const parentReal = realpathSync(dirname(dest));
  invariant(isWithin(parentReal, userRoot), `destination ${dest} resolves outside the USER tree (${parentReal})`);
  const secret = isSecretFileName(f.rel.split(sep).pop()!);
  if (secret) {
    writeExclusive(dest, readFileSync(f.src), 0o600);
  } else {
    copyFileSync(f.src, dest, fsConstants.COPYFILE_EXCL);
    chmodSync(dest, (f.stat.mode & 0o777) | 0o600);
  }
  // Keep the old modification time: freshness checks read it, and an import must not make old claims look new.
  utimesSync(dest, f.stat.atime, f.stat.mtime);
}

/** Create `dest` with O_CREAT|O_EXCL at `mode`, so the bytes are never readable by anyone else, even briefly. */
function writeExclusive(dest: string, bytes: Uint8Array, mode: number): void {
  const fd = openSync(dest, "wx", mode);
  try {
    fchmodSync(fd, mode);
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  } finally {
    closeSync(fd);
  }
}

// ── Env handling ─────────────────────────────────────────────────────

function firstEnvFile(candidates: string[]): string | null {
  const seen = new Set<string>();
  for (const c of candidates) {
    const real = realOrNull(c);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    if (statSync(real).isFile()) return real;
  }
  return null;
}

const SECRETS_SET = "bun LIFEOS/TOOLS/Secrets.ts set <KEY>";

function handleEnv(source: Source, configRootReal: string, apply: boolean): EnvReport {
  const newEnv = join(configRootReal, ".env");
  const found = firstEnvFile(source.envCandidates);
  if (!found) return { found: null, action: "none-found", keysMissing: [], instructions: null };

  const oldKeys = envKeyNames(readFileSync(found, "utf8"));
  const newSt = lstatOrNull(newEnv);
  if (!newSt) {
    if (!apply) {
      return { found, action: "would-copy", keysMissing: [], instructions: "This install has no .env yet; --apply copies the old one at mode 0600." };
    }
    invariant(realpathSync(dirname(newEnv)) === configRootReal, `env destination ${newEnv} is not directly in the config root`);
    invariant(lstatOrNull(newEnv) === null, `refusing to overwrite ${newEnv}`);
    writeExclusive(newEnv, readFileSync(found), 0o600);
    return {
      found, action: "copied", keysMissing: [],
      instructions: "The old .env was copied at mode 0600. If this install seals secrets, run `bun LIFEOS/TOOLS/Secrets.ts seal` next.",
    };
  }

  let newKeys = new Map<string, boolean>();
  const newReal = realOrNull(newEnv);
  if (newReal && statSync(newReal).isFile()) newKeys = envKeyNames(readFileSync(newReal, "utf8"));
  const keysMissing = [...oldKeys.entries()].filter(([k, has]) => has && !newKeys.get(k)).map(([k]) => k).sort();
  return {
    found, action: "kept-existing", keysMissing,
    instructions: keysMissing.length
      ? `This install already has a .env, so it was left alone. For each missing key, run \`${SECRETS_SET}\` and have the principal enter the value (echo off; never paste it into chat).`
      : "This install already has a .env with every key the old one had; it was left alone.",
  };
}

// ── Side findings ────────────────────────────────────────────────────

function otherCandidates(source: Source): string[] {
  if (!source.harnessRoot) return [];
  const dir = join(source.harnessRoot, source.shape === "pai-config-root" ? "PAI" : "LIFEOS");
  try {
    return readdirSync(dir).filter((n) => n.startsWith("USER.pre-link-backup-")).sort().map((n) => join(dir, n))
      .filter((p) => isRealDir(p));
  } catch { return []; }
}

function privateSkillsNotImported(source: Source, configRootReal: string): string[] {
  if (!source.harnessRoot) return [];
  try {
    return readdirSync(join(source.harnessRoot, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("_") && !existsSync(join(configRootReal, "skills", e.name)))
      .map((e) => e.name).sort();
  } catch { return []; }
}

// ── Main ─────────────────────────────────────────────────────────────

function emptyReport(o: ImportOpts): ImportReport {
  return {
    ok: false, dryRun: !o.apply,
    from: { path: o.from, shape: null, layout: null, userTree: null, memoryTree: null, version: null },
    to: { configRoot: o.configRoot, userTree: null, envFile: join(o.configRoot, ".env") },
    counts: { copied: 0, identical: 0, conflicts: 0, skipped: 0, failed: 0 },
    copied: [], copiedTruncated: 0, conflicts: [], skipped: {}, failures: [],
    env: { found: null, action: "none-found", keysMissing: [], instructions: null },
    otherCandidates: [], privateSkillsNotImported: [], next: "",
  };
}

export function importPrevious(o: ImportOpts): ImportReport {
  const report = emptyReport(o);

  const configRootReal = realOrNull(o.configRoot);
  if (!configRootReal) {
    report.error = `config root ${o.configRoot} does not exist`;
    report.next = "Run Setup first, then import.";
    return report;
  }
  report.to.configRoot = configRootReal;
  report.to.envFile = join(configRootReal, ".env");
  const userRoot = realOrNull(join(configRootReal, "LIFEOS", "USER"));
  if (!userRoot || !statSync(userRoot).isDirectory()) {
    report.error = `this install has no USER tree at ${join(configRootReal, "LIFEOS", "USER")}`;
    report.next = "Run Setup through LinkUser (step 6) first, then import.";
    return report;
  }
  report.to.userTree = userRoot;

  const det = detectSource(o.from);
  if (!det.ok) {
    report.error = det.error;
    report.next = "Ask the principal where the earlier install or its backup lives, then run again with that --from.";
    return report;
  }
  const source = det.source;
  report.from = {
    path: source.root, shape: source.shape, layout: source.layout, userTree: source.userTree,
    memoryTree: source.memoryTree, version: source.version,
  };

  if (source.userTree === userRoot) {
    report.ok = true;
    report.next = "The old USER tree is this install's USER tree already (an in-place upgrade): nothing to import. Run the Interview's ContextCheckin to review the carried-over context.";
    return report;
  }
  if (isWithin(source.userTree, userRoot) || isWithin(userRoot, source.userTree)) {
    report.error = `the source USER tree ${source.userTree} and this install's ${userRoot} contain one another; refusing to copy a tree into itself`;
    report.next = "Point --from at a backup that sits outside this install.";
    return report;
  }

  if (o.apply && !o.allowDev) {
    const v = findDevWriteViolation([configRootReal, userRoot, report.to.envFile], [configRootReal]);
    if (v) {
      report.refused = "dev-tree";
      report.error = `${v.target} resolves to ${v.resolved}, inside the LifeOS dev install at ${v.devRoot} (${v.via}); refusing to write.`;
      report.next = "Point --config-root at the adopter's install, or use --allow-dev only in a sandbox.";
      return report;
    }
  }

  const plan = buildPlan(source);
  report.failures.push(...plan.unreadable);
  const sourceRoots = [source.userTree, ...(source.memoryTree ? [source.memoryTree] : [])];
  const templateRoot = realOrNull(join(configRootReal, "skills", "LifeOS", "install", "USER"));

  for (const f of plan.files) {
    const dest = join(userRoot, f.rel);
    try {
      const dir = ensureDir(userRoot, dirname(f.rel) === "." ? "" : dirname(f.rel), plan.dirModes, o.apply);
      if (dir.state === "blocked") {
        report.conflicts.push({ path: f.rel, kind: dir.kind, fromBytes: f.stat.size, toBytes: 0, destIsTemplate: false });
        continue;
      }
      const dst = dir.state === "absent" ? null : lstatOrNull(dest);
      if (dst) {
        if (dst.isSymbolicLink()) {
          report.conflicts.push({ path: f.rel, kind: "symlink", fromBytes: f.stat.size, toBytes: 0, destIsTemplate: false });
        } else if (!dst.isFile()) {
          report.conflicts.push({ path: f.rel, kind: "type", fromBytes: f.stat.size, toBytes: 0, destIsTemplate: false });
        } else if (sameBytes(f.src, dest, f.stat.size)) {
          report.counts.identical++;
        } else {
          report.conflicts.push({
            path: f.rel, kind: "content", fromBytes: f.stat.size, toBytes: dst.size,
            destIsTemplate: templateMatches(templateRoot, f.rel, dest),
          });
        }
        continue;
      }
      if (o.apply) copyNew(f, dest, userRoot, sourceRoots);
      report.counts.copied++;
      if (report.copied.length < COPIED_LIST_CAP) report.copied.push(f.rel);
      else report.copiedTruncated++;
    } catch (e) {
      if (e instanceof InvariantViolation) throw e;
      report.failures.push({ path: f.rel, error: e instanceof Error ? e.message : String(e) });
    }
  }

  try {
    report.env = handleEnv(source, configRootReal, o.apply);
  } catch (e) {
    if (e instanceof InvariantViolation) throw e;
    report.failures.push({ path: ".env", error: e instanceof Error ? e.message : String(e) });
  }

  for (const [cat, v] of [...plan.skipped.entries()].sort(([a], [b]) => a.localeCompare(b))) report.skipped[cat] = v;
  report.otherCandidates = otherCandidates(source);
  report.privateSkillsNotImported = privateSkillsNotImported(source, configRootReal);
  report.counts.conflicts = report.conflicts.length;
  report.counts.skipped = [...plan.skipped.values()].reduce((n, v) => n + v.count, 0);
  report.counts.failed = report.failures.length;
  report.ok = report.failures.length === 0;
  report.next = nextStep(report, o.apply);
  return report;
}

function nextStep(r: ImportReport, apply: boolean): string {
  const parts: string[] = [];
  if (!apply) parts.push(`Dry run: ${r.counts.copied} file(s) would be copied. Show the principal this summary, then re-run with --apply.`);
  else parts.push(`${r.counts.copied} file(s) copied, nothing overwritten.`);
  if (r.counts.failed) parts.push(`${r.counts.failed} file(s) failed; read \`failures\` and fix before trusting the import.`);
  if (r.counts.conflicts) {
    const tpl = r.conflicts.filter((c) => c.destIsTemplate).length;
    parts.push(`${r.counts.conflicts} conflict(s): for each, ask the principal whether to keep this install's file or take the old one${tpl ? ` (${tpl} still hold the untouched template, so taking the old file there loses nothing)` : ""}; this tool never chooses.`);
  }
  if (r.env.keysMissing.length) parts.push(`${r.env.keysMissing.length} key(s) missing from this install's .env: run \`${SECRETS_SET}\` for each.`);
  if (r.otherCandidates.length) parts.push(`Earlier USER backups also exist (${r.otherCandidates.length}); offer to import them with another run.`);
  if (r.privateSkillsNotImported.length) parts.push(`The old install had private skills this one lacks (${r.privateSkillsNotImported.join(", ")}); they are not imported, so offer to review and copy them by hand.`);
  parts.push("Then run the Interview's ContextCheckin (`Skill(\"Interview\")`, ContextCheckin) so the principal reviews the imported context.");
  return parts.join(" ");
}

// ── CLI ──────────────────────────────────────────────────────────────

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1]!.startsWith("--") ? a[i + 1] : undefined;
}

const VALUED = new Set(["--from", "--config-root"]);
const KNOWN_FLAGS = new Set([...VALUED, "--apply", "--dry-run", "--json", "--allow-dev", "--help", "-h"]);

export function parseArgs(
  a: string[], env: Record<string, string | undefined> = process.env, home: string = homedir(),
): (ImportOpts & { json: boolean }) | { error: string } {
  for (const f of VALUED) if (a.includes(f) && arg(a, f) === undefined) return { error: `${f} needs a value` };
  for (let i = 0; i < a.length; i++) {
    if (VALUED.has(a[i]!)) { i++; continue; }
    if (!KNOWN_FLAGS.has(a[i]!)) return { error: `unknown argument: ${a[i]}` };
  }
  const from = arg(a, "--from");
  if (!from) return { error: "--from <dir> is required: the earlier install, its data home, or a backup of either" };
  if (a.includes("--apply") && a.includes("--dry-run")) return { error: "--apply and --dry-run contradict each other" };
  const cwd = process.cwd();
  return {
    from: isAbsolute(from) ? from : resolve(cwd, from),
    configRoot: resolve(arg(a, "--config-root") || env.CLAUDE_CONFIG_DIR || join(env.HOME || home, ".claude")),
    apply: a.includes("--apply"),
    allowDev: a.includes("--allow-dev"),
    json: a.includes("--json"),
  };
}

export function renderHuman(r: ImportReport): string {
  const lines: string[] = [];
  lines.push(`${r.ok ? "OK" : "NOT OK"}${r.dryRun ? " (dry run, nothing written)" : ""}`);
  if (r.error) lines.push(`Error: ${r.error}`);
  if (r.from.shape) lines.push(`From: ${r.from.path} (${r.from.shape}${r.from.layout ? `, ${r.from.layout}` : ""}${r.from.version ? `, v${r.from.version}` : ""})`);
  if (r.to.userTree) lines.push(`To: ${r.to.userTree}`);
  const c = r.counts;
  lines.push(`Copied ${c.copied} · identical ${c.identical} · conflicts ${c.conflicts} · skipped ${c.skipped} · failed ${c.failed}`);
  for (const k of r.conflicts) lines.push(`  Conflict (${k.kind}): ${k.path}  old ${k.fromBytes} B, this install ${k.toBytes} B${k.destIsTemplate ? " (untouched template)" : ""}`);
  for (const [cat, v] of Object.entries(r.skipped)) lines.push(`  Skipped ${cat}: ${v!.count} (e.g. ${v!.examples.join(", ")})`);
  for (const f of r.failures) lines.push(`  Failed: ${f.path}: ${f.error}`);
  lines.push(`Env: ${r.env.action}${r.env.keysMissing.length ? `; keys missing: ${r.env.keysMissing.join(", ")}` : ""}`);
  if (r.env.instructions) lines.push(`  ${r.env.instructions}`);
  lines.push(`Next: ${r.next}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  if (a.includes("--help") || a.includes("-h")) {
    console.log(readFileSync(join(import.meta.dir, "ImportPrevious.help.md"), "utf8"));
    process.exit(0);
  }
  const parsed = parseArgs(a);
  if ("error" in parsed) {
    console.log(JSON.stringify({ ok: false, error: parsed.error }, null, 2));
    process.exit(64);
  }
  const report = importPrevious(parsed);
  console.log(parsed.json ? JSON.stringify(report, null, 2) : renderHuman(report));
  process.exit(report.refused ? 2 : report.ok ? 0 : 1);
}
