#!/usr/bin/env bun
/**
 * WorkflowNames — fails when a Claude Code workflow script breaks the LifeOS naming convention.
 *
 * Every named thing in LifeOS is TitleCase and matches its file name (SkillSystem.md), so a
 * workflow is `workflows/UpgradeFanout.js` with `meta.name: 'UpgradeFanout'`, never a kebab-case name
 * (2026-10-03).
 *
 *   bun LIFEOS/TOOLS/WorkflowNames.ts [--dir <workflows dir>] [--tracked] [--json]
 *
 * Checks every `*.js` directly in the directory:
 *   file-not-titlecase              the file stem is not ^[A-Z][A-Za-z0-9]*$
 *   meta-name-missing               no `name:` literal inside `export const meta = { … }`
 *   meta-name-not-titlecase         meta.name is not TitleCase
 *   meta-name-differs-from-file     meta.name is TitleCase but is not the file stem
 *
 * With --tracked it also reads the git index for that directory:
 *   tracked-name-not-titlecase      git tracks a `*.js` there under a non-TitleCase name
 * This is the half the disk check cannot see on a case-insensitive checkout (core.ignorecase=true):
 * renaming hello.js to Hello.js and running `git add -- Hello.js` updates the existing `hello.js`
 * index entry, so the commit keeps the old name while `ls` shows the new one, and a case-sensitive
 * clone gets a file whose stem no longer equals its meta.name.
 *
 * Exit codes: 0 clean, 1 violations (or a directory with no workflows), 2 usage or not a git checkout.
 * Read-only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type WorkflowNameProblem =
  | "file-not-titlecase"
  | "meta-name-missing"
  | "meta-name-not-titlecase"
  | "meta-name-differs-from-file"
  | "tracked-name-not-titlecase";

export interface WorkflowNameViolation {
  file: string;
  metaName: string | null;
  problem: WorkflowNameProblem;
}

export interface WorkflowNameReport {
  ok: boolean;
  dir: string;
  checked: number;
  /** Tracked `*.js` names in the directory, present only when the index was read. */
  tracked?: string[];
  violations: WorkflowNameViolation[];
}

const TITLE_CASE = /^[A-Z][A-Za-z0-9]*$/;
const META_NAME = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*(['"`])([^'"`]*)\1/;

export const DEFAULT_WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "workflows");

export function isTitleCase(name: string): boolean {
  return TITLE_CASE.test(name);
}

/** The `name:` literal inside `export const meta = {…}`, or null when there is none. */
export function metaName(source: string): string | null {
  return source.match(META_NAME)?.[2] ?? null;
}

export function checkWorkflowSource(file: string, source: string): WorkflowNameViolation[] {
  const stem = basename(file).replace(/\.js$/, "");
  const name = metaName(source);
  const out: WorkflowNameViolation[] = [];
  if (!isTitleCase(stem)) out.push({ file, metaName: name, problem: "file-not-titlecase" });
  if (name === null) out.push({ file, metaName: null, problem: "meta-name-missing" });
  else if (!isTitleCase(name)) out.push({ file, metaName: name, problem: "meta-name-not-titlecase" });
  else if (name !== stem) out.push({ file, metaName: name, problem: "meta-name-differs-from-file" });
  return out;
}

/** The `*.js` names git tracks directly in `dir`, exactly as the index spells them; null outside a git checkout. */
export function trackedWorkflowFiles(dir: string): string[] | null {
  const r = spawnSync("git", ["-C", dir, "ls-files", "-z", "--", "."], { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0 || r.error) return null;
  return r.stdout.split("\0").filter((f) => f.endsWith(".js") && !f.includes("/")).sort();
}

export function checkWorkflowDir(dir: string, opts: { tracked?: string[] } = {}): WorkflowNameReport {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".js") && statSync(join(dir, f)).isFile())
    .sort();
  const violations = files.flatMap((f) => checkWorkflowSource(f, readFileSync(join(dir, f), "utf8")));
  if (opts.tracked) {
    for (const f of opts.tracked) {
      if (!isTitleCase(f.replace(/\.js$/, ""))) violations.push({ file: f, metaName: null, problem: "tracked-name-not-titlecase" });
    }
  }
  return {
    ok: files.length > 0 && violations.length === 0,
    dir,
    checked: files.length,
    ...(opts.tracked ? { tracked: opts.tracked } : {}),
    violations,
  };
}

function main(argv: string[]): number {
  let dir = DEFAULT_WORKFLOWS_DIR;
  let json = false;
  let readIndex = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--tracked") readIndex = true;
    else if (a === "--dir" && argv[i + 1]) dir = argv[++i]!;
    else if (a === "--help" || a === "-h") {
      console.log("usage: bun LIFEOS/TOOLS/WorkflowNames.ts [--dir <workflows dir>] [--tracked] [--json]");
      return 0;
    } else {
      console.error(`WorkflowNames: unknown argument ${a}`);
      return 2;
    }
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`WorkflowNames: ${dir} is not a directory`);
    return 2;
  }
  let tracked: string[] | undefined;
  if (readIndex) {
    const t = trackedWorkflowFiles(dir);
    if (t === null) {
      console.error(`WorkflowNames: --tracked needs a git checkout, and ${dir} is not in one`);
      return 2;
    }
    tracked = t;
  }
  const report = checkWorkflowDir(dir, { tracked });
  if (json) console.log(JSON.stringify(report));
  else if (report.checked === 0) console.error(`WorkflowNames: no workflow scripts in ${dir}`);
  else if (report.ok) console.log(`WorkflowNames: ${report.checked} workflows, all TitleCase and matching their files`);
  else {
    console.error(`WorkflowNames: ${report.violations.length} naming violation(s) in ${dir}`);
    for (const v of report.violations) console.error(`  ${v.file}  ${v.problem}${v.metaName !== null ? `  (meta.name: ${v.metaName})` : ""}`);
  }
  return report.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
