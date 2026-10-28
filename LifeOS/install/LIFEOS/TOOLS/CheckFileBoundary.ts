#!/usr/bin/env bun
/**
 * @version 1.1.8
 * CheckFileBoundary.ts — on-demand SystemFileGuard check.
 *
 * Wraps the same `evaluateWrite()` logic the runtime hook uses, but for use
 * in CI / pre-commit / ad-hoc audits. Reads a file's current content from
 * disk (or stdin) and reports whether it would be blocked if it were the
 * new content of a write to that path.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/CheckFileBoundary.ts <file>           # check file on disk
 *   bun LIFEOS/TOOLS/CheckFileBoundary.ts <file> --stdin   # check content from stdin
 *   bun LIFEOS/TOOLS/CheckFileBoundary.ts --help
 *
 * Exit codes:
 *   0  -> allowed (USER zone, out-of-tree, or clean SYSTEM file)
 *   1  -> blocked (SYSTEM file with deny-list match)
 *   2  -> usage error
 */

import { readFileSync, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { evaluateWrite } from "../../hooks/lib/system-file-guard-core";
import { confinedPath } from "./lib/Boundary";

function usage(code = 2): never {
  console.log(
    `CheckFileBoundary — boundary doctrine on-demand check\n\n` +
      `Usage:\n` +
      `  bun ${process.argv[1]} <file>          # check file content on disk\n` +
      `  bun ${process.argv[1]} <file> --stdin  # check content piped on stdin\n` +
      `  bun ${process.argv[1]} <dir>           # check every file in dir (recursive)\n` +
      `  bun ${process.argv[1]} --help\n\n` +
      `Exit: 0 allow / 1 blocked / 2 usage error.`,
  );
  process.exit(code);
}

export interface Collected {
  /** Regular files to check, by the path the scan reached them at. */
  files: string[];
  /** In-tree symlinks to regular files: checked at the link path and at the canonical destination. */
  links: { link: string; target: string }[];
  /** Entries the scan refuses to vouch for: a dangling link, a link escaping the scan root, an unsupported type. */
  refused: { path: string; reason: string }[];
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Inventory everything under target. Symlinks are never silently dropped: each is resolved
 * with realpathSync, and a link that cannot be resolved, or whose canonical destination leaves the canonical scan
 * root, is refused, which blocks the run. A link to a directory inside the root adds nothing new (the walk reaches
 * that directory at its real path) and counts as inspected; a link to a file inside the root is checked at both paths.
 */
export function collectFiles(target: string): Collected {
  const out: Collected = { files: [], links: [], refused: [] };
  const resolveLink = (p: string): string | undefined => {
    try { return realpathSync(p); } catch (e) { out.refused.push({ path: p, reason: `unresolved symlink (${(e as NodeJS.ErrnoException).code ?? "error"})` }); return undefined; }
  };
  // A target that is itself a symlink is one entry: a file link is checked at both paths, a directory link is refused.
  if (lstatSync(target).isSymbolicLink()) {
    const real = resolveLink(target);
    if (real === undefined) return out;
    const rst = lstatSync(real);
    if (rst.isFile()) out.links.push({ link: target, target: real });
    else out.refused.push({ path: target, reason: `scan target is a symlink to ${real}; scan the real path instead` });
    return out;
  }
  const root = realpathSync(target);
  const visit = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      const real = resolveLink(p);
      if (real === undefined) return;
      if (!within(root, real)) { out.refused.push({ path: p, reason: `symlink escapes the scan root to ${real}` }); return; }
      const rst = lstatSync(real);
      if (rst.isFile()) out.links.push({ link: p, target: real });
      else if (!rst.isDirectory()) out.refused.push({ path: p, reason: "symlink to an unsupported file type" });
      return;
    }
    if (st.isDirectory()) { for (const entry of readdirSync(p)) visit(join(p, entry)); return; }
    if (st.isFile()) { out.files.push(p); return; }
    out.refused.push({ path: p, reason: "unsupported file type (not a regular file, directory or symlink)" });
  };
  visit(target);
  return out;
}

/**
 * Check every inventoried entry. blocked is true when any entry is blocked or refused. `writtenOf` maps a path the
 * walk reached to the path the caller named it by (S082): each entry is then also judged at that written path, with
 * the content read once from where the walk found it. Either judgment blocking blocks.
 */
export function scanTarget(target: string, check: (absPath: string, content: string) => boolean = checkOne, writtenOf?: (p: string) => string): { blocked: boolean; count: number } {
  const c = collectFiles(target);
  let blocked = false;
  const judge = (p: string, content: string): void => {
    if (!check(p, content)) blocked = true;
    const w = writtenOf?.(p);
    if (w !== undefined && w !== p && !check(w, content)) blocked = true;
  };
  for (const r of c.refused) { console.error(`BLOCK  ${r.path}\n       ${r.reason}`); blocked = true; }
  for (const f of c.files) judge(f, readFileSync(f, "utf-8"));
  for (const l of c.links) {
    const content = readFileSync(l.target, "utf-8");
    judge(l.link, content);
    if (!check(l.target, content)) blocked = true;
  }
  return { blocked, count: c.files.length + c.links.length + c.refused.length };
}

/**
 * The written-path mapper for a scan of `physical` named as `asWritten` (S082 review round 2). The scan never walks
 * the written form: Bun's realpathSync folds `link/..` lexically before resolving and path.join folds it while
 * building child paths, so a walk of `skills/alias/../dir` lands on the lexical `skills/dir`, a different file. The
 * walk runs over the physical target (no `..` left in it) and every entry keeps the caller's spelling as its prefix.
 */
export function writtenPathMapper(physical: string, asWritten: string): (p: string) => string {
  const base = asWritten.length > 1 ? asWritten.replace(/\/+$/, "") || sep : asWritten;
  return (p: string): string => {
    if (p === physical) return asWritten;
    // collectFiles reaches every entry by joining names onto the target, so rel is always a plain descendant path.
    const rel = relative(physical, p);
    return base === sep ? `${sep}${rel}` : `${base}${sep}${rel}`;
  };
}

/**
 * The path the kernel opens for `asWritten` (S082): every directory component is walked physically through the
 * shared Boundary primitive, so `link/../x` steps out of the directory the link leads to, never out of the link's
 * lexical parent. The last component is kept as written, so a target that is itself a symlink is still seen as one
 * (and checked at both of its paths). null when the location cannot be established (a loop, a permission error,
 * `..` after a missing component). A written path ending in `/` or `/.` names a directory, as it does to the kernel
 * (final round 2): the target always keeps its trailing separator, so a file is not found (never judged as the
 * file) and a directory link is followed to its directory, as the kernel and HEAD both do.
 */
export function physicalTarget(asWritten: string): string | null {
  const raw = asWritten.split(sep);
  const mustBeDir = raw.length > 1 && (raw.at(-1) === "" || raw.at(-1) === ".");
  const parts = raw.filter((c) => c !== "" && c !== ".");
  const last = parts.at(-1);
  if (last === undefined) return sep;
  if (last === "..") return confinedPath(sep, asWritten);
  const parent = confinedPath(sep, sep + parts.slice(0, -1).join(sep));
  if (parent === null) return null;
  const target = join(parent, last);
  return mustBeDir ? target + sep : target;
}

function checkOne(absPath: string, content: string): boolean {
  const decision = evaluateWrite(absPath, content);
  if (!decision.block) {
    return true;
  }
  const hit = decision.hits[0]!;
  console.error(`BLOCK  ${decision.relPath}`);
  console.error(`       pattern: ${hit.pattern}`);
  console.error(`       match:   ${hit.match}`);
  return false;
}

/** One CLI judgment: the exit code, the physical target, and how many entries a disk scan inspected. */
export interface PathJudgment { exit: 0 | 1 | 2; target: string | null; count: number; error?: string }

/**
 * Judge `targetRaw` (relative to `cwd`) the way the CLI does: content from `stdinContent` when given, else from disk.
 */
export function judgePath(targetRaw: string, cwd: string, check: (absPath: string, content: string) => boolean = checkOne, stdinContent?: string): PathJudgment {
  // Never fold the path lexically first (resolve() turns `link/../x` into `x` without following `link`).
  const asWritten = isAbsolute(targetRaw) ? targetRaw : `${cwd}${sep}${targetRaw}`;
  const target = physicalTarget(asWritten);
  if (target === null) return { exit: 2, target, count: 0, error: `cannot resolve where ${targetRaw} leads (a loop, a permission error, or .. past a missing directory)` };
  if (!existsSync(target)) return { exit: 2, target, count: 0, error: `target not found: ${target}` };

  if (stdinContent !== undefined) {
    // Judged at the physical path and as written (the guard core walks the written form itself); either blocking blocks.
    const physicalOk = check(target, stdinContent);
    const writtenOk = asWritten === target || check(asWritten, stdinContent);
    return { exit: physicalOk && writtenOk ? 0 : 1, target, count: 1 };
  }
  // A disk scan is judged at both forms too (S082 review): the physical path alone drops the class of the path as
  // written (`skills/<alias>/x.ts` through a link into USER is a SYSTEM write), which the guard core judges itself
  // when handed the written form. One physical walk; each entry is judged at its physical and its written path
  // (writtenPathMapper), with the content read from the file the kernel opens. Either form blocking blocks.
  const r = scanTarget(target, check, asWritten === target ? undefined : writtenPathMapper(target, asWritten));
  return { exit: r.blocked ? 1 : 0, target, count: r.count };
}

function main(): never {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage(args.length === 0 ? 2 : 0);

  const fromStdin = args.includes("--stdin");
  const filtered = args.filter((a) => !a.startsWith("--"));
  if (filtered.length !== 1) usage(2);
  const j = judgePath(filtered[0]!, process.cwd(), checkOne, fromStdin ? readFileSync(0, "utf-8") : undefined);
  if (j.error) console.error(`CheckFileBoundary: ${j.error}`);
  else if (!fromStdin && j.exit === 0 && j.count === 1) console.log(`OK     ${j.target}`);
  else if (!fromStdin && j.exit === 0 && j.count > 1) console.log(`OK     ${j.count} entries scanned, zero blocks.`);
  process.exit(j.exit);
}

if (import.meta.main) main();
