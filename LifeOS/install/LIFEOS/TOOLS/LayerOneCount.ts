#!/usr/bin/env bun
/**
 * LayerOneCount.ts — counts the deterministic rules on the three guarded surfaces and
 * compares the staged version of each against HEAD. The commit-msg guard
 * (LIFEOS/TOOLS/githooks/commit-msg) calls `--staged-vs-head` when a commit message
 * cites the Glance system or its engine: a staged count lower than HEAD is refused.
 *
 * The rule is monotone non-decreasing counts, which is what the program ISA's ISC-42
 * states. The previous check refused any deleted line in a guarded file, comments and
 * imports included, and so refused commits that removed no rule (issue #1225).
 *
 * Known limit, shared with the /ic layer-one-monotone gate: a count cannot see one rule
 * swapped for a different one. The test file names this case.
 *
 * Exit codes for --staged-vs-head: 0 no guarded count fell · 1 a count fell, or a staged
 * guarded file could not be counted (fail closed: only reachable when a guarded file is
 * staged and the message cites the judgment system).
 */
import { execFileSync } from "node:child_process";

export const GUARDED = [
  "hooks/lib/containment-zones.ts",
  "hooks/lib/egress-shapes.ts",
  "settings.json",
] as const;
export type GuardedPath = typeof GUARDED[number];

/** Code lines: not blank, not a comment line. Every code line in a rules file is a rule or holds one up. */
function codeLines(content: string): number {
  return content.split("\n").filter((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).length;
}

/** Pure. The rule count for one guarded file's content. */
export function countLayerOne(path: GuardedPath, content: string): number {
  if (path === "settings.json") {
    const deny = JSON.parse(content)?.permissions?.deny;
    return Array.isArray(deny) ? deny.length : 0;
  }
  return codeLines(content);
}

export type Drop = { path: string; head: number; staged: number };

/** Pure. Paths whose staged count is below HEAD's. A file absent on one side counts 0 there. */
export function drops(versions: Array<{ path: GuardedPath; head: string | null; staged: string | null }>): Drop[] {
  const out: Drop[] = [];
  for (const v of versions) {
    const head = v.head === null ? 0 : countLayerOne(v.path, v.head);
    const staged = v.staged === null ? 0 : countLayerOne(v.path, v.staged);
    if (staged < head) out.push({ path: v.path, head, staged });
  }
  return out;
}

export type GitResult = { ok: true; out: string } | { ok: false };
export type GitRunner = (args: string[]) => GitResult;

export const runGit: GitRunner = (args) => {
  try {
    return { ok: true, out: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }) };
  } catch {
    return { ok: false };
  }
};

export type Versions = Array<{ path: GuardedPath; head: string | null; staged: string | null }>;

/**
 * The staged and HEAD versions of every staged guarded file. A git failure THROWS: it never
 * becomes an empty file list or a zero-count version, which would make the guard pass without
 * looking. A file that is truly absent on one side (new file, unborn HEAD, staged deletion)
 * is null there, and that is told apart from an error by asking git whether the path exists
 * (ls-tree / ls-files) before reading it.
 */
/**
 * True when HEAD resolves to a commit, false only for a genuinely unborn branch: HEAD is a symbolic
 * ref and no such ref exists yet. Any other failure to verify HEAD throws, so a git error can never
 * read as "no baseline" and let a guarded deletion through.
 */
export function headIsBorn(git: GitRunner): boolean {
  if (git(["rev-parse", "--verify", "-q", "HEAD"]).ok) return true;
  const sym = git(["symbolic-ref", "-q", "HEAD"]);
  if (!sym.ok) throw new Error("HEAD could not be verified and is not a symbolic ref");
  const ref = sym.out.trim();
  if (!ref.startsWith("refs/")) throw new Error(`HEAD names an unexpected ref: ${JSON.stringify(ref)}`);
  const refs = git(["for-each-ref", "--format=%(refname)", ref]);
  if (!refs.ok) throw new Error(`git for-each-ref failed for ${ref}`);
  if (refs.out.trim() !== "") throw new Error(`HEAD ref ${ref} exists but could not be verified`);
  return false; // unborn: the branch has no commit yet, so there is no HEAD baseline
}

export function readVersions(git: GitRunner): Versions {
  const diff = git(["diff", "--cached", "--name-only", "--", ...GUARDED]);
  if (!diff.ok) throw new Error("git diff --cached failed");
  const staged = new Set(diff.out.split("\n").filter(Boolean));
  const inRepo = git(["rev-parse", "--git-dir"]);
  if (!inRepo.ok) throw new Error("not a git repository");
  const headExists = headIsBorn(git);
  const read = (probe: string[], show: string[], what: string): string | null => {
    const listed = git(probe);
    if (!listed.ok) throw new Error(`git ${probe[0]} failed for ${what}`);
    if (listed.out.trim() === "") return null; // absent on this side
    const shown = git(show);
    if (!shown.ok) throw new Error(`git show failed for ${what}`);
    return shown.out;
  };
  return GUARDED.filter((p) => staged.has(p)).map((path) => ({
    path,
    head: headExists ? read(["ls-tree", "HEAD", "--", path], ["show", `HEAD:${path}`], `HEAD:${path}`) : null,
    staged: read(["ls-files", "--stage", "--", path], ["show", `:${path}`], `:${path}`),
  }));
}

if (import.meta.main) {
  if (process.argv[2] !== "--staged-vs-head") {
    console.error("usage: bun LIFEOS/TOOLS/LayerOneCount.ts --staged-vs-head");
    process.exit(2);
  }
  try {
    const versions = readVersions(runGit);
    const fell = drops(versions);
    for (const v of versions) {
      const h = v.head === null ? 0 : countLayerOne(v.path, v.head);
      const s = v.staged === null ? 0 : countLayerOne(v.path, v.staged);
      console.error(`   ${v.path}: HEAD ${h} → staged ${s}`);
    }
    process.exit(fell.length ? 1 : 0);
  } catch (err) {
    console.error(`   LayerOneCount could not count a staged guarded file: ${String(err).slice(0, 200)}`);
    process.exit(1);
  }
}
