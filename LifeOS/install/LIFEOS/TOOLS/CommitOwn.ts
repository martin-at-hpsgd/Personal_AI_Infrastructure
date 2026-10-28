#!/usr/bin/env bun
/**
 * @version 2.3.0
 * CommitOwn.ts — commit only the paths you name, in a working tree other sessions share.
 *
 *   bun LIFEOS/TOOLS/CommitOwn.ts -m "subject" [-m "body or trailer" ...] [--force|--staged] -- <path> [<path> ...]
 *
 * --force includes named paths that .gitignore excludes (git add -N -f), for a file kept on purpose inside an
 * ignored tree (an ISA's evidence files under MEMORY/WORK/<slug>/). It still commits only the named paths.
 *
 * The commit is `git commit --only`: git builds a temporary index from HEAD plus the named paths, commits that,
 * and leaves every other entry in the shared index exactly as it was, so another session's staged files neither
 * ride along nor block the commit (2026-10-09: a commit meant for a few staged evidence files swept in a peer session's staged files). New files
 * are marked intent-to-add first, the only way --only can see them. Deletions and directories work.
 * All paths must sit in one repository. Exit 0 committed, 2 usage, 3 nothing to commit, 1 git failed.
 * Prints one JSON line; `left_staged` lists other sessions' staged entries it left in place.
 *
 * The named files are committed as they are on disk, so a peer's uncommitted lines in the same file come with them.
 * --staged commits the named paths as they are in the index instead: stage HEAD plus only your lines
 * (`git hash-object -w` + `git update-index --cacheinfo`), then run with --staged. The commit is built in a
 * temporary index of HEAD plus those entries, so hooks still run, the peer's lines stay on disk, and the shared
 * index is left as it was (2026-10-24: the plain `git commit` that recipe used is refused in the private trees).
 *
 * Every commit appends one STATVS `commit` row with the session that made it and the full sha as ref, so a commit
 * leads back to its conversation (STATVS ISA F17). The record loads lazily and never changes the commit's outcome:
 * `statvs` in the result says recorded, spooled, refused or unavailable.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths";

export interface CommitOwnResult { ok: boolean; code: 0 | 1 | 2 | 3; repo: string | null; commit: string | null; files: string[]; left_staged: string[]; error: string | null; adopted?: string[]; statvs?: string }

function git(cwd: string, args: string[], input?: string, env: Record<string, string> = {}): { ok: boolean; out: string; err: string } {
  // Literal pathspecs: a named path is a path, never a glob.
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env } });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const list = (out: string) => out.split("\0").filter(Boolean);
const staged = (repo: string) => list(git(repo, ["diff", "--cached", "--name-only", "-z"]).out);

/** The nearest existing directory at or above p, so a deleted file still resolves to its repository. */
function existingDir(p: string): string {
  let d = dirname(p);
  while (!existsSync(d) && d !== dirname(d)) d = dirname(d);
  return d;
}

const FOLD_OWNED = ["LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md", "LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md"];

/**
 * A committed edit to a Cortex-ledger memory file is adopted into the ledger right away, so a rename sweep never
 * leaves the ledger behind (MemorySystem.md § The Cortex Ledger). Best-effort: the commit already landed, and the
 * reviewer's next write adopts a committed edit on its own if this fails. Only the committed files are checked, but
 * `adopt` covers both memory files, so a drifted sibling with no lost entries is adopted too.
 */
function adoptCommittedMemory(repo: string, files: string[]): string[] {
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  const owned = new Set(FOLD_OWNED.map((r) => real(resolve(getClaudeDir(), r))).filter(Boolean));
  const hit = files.map((f) => real(resolve(repo, f))).filter((p): p is string => p !== null && owned.has(p));
  if (!hit.length) return [];
  // A child process keeps the memory stack out of every other commit; `adopt` also replays parked reviewer items.
  // GIT_* stripped so a caller inside a git hook cannot point the child's git queries at another repo; a stuck lock
  // must not hang a commit that already landed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("bun", [resolve(import.meta.dir, "CortexLedger.ts"), "adopt"], { encoding: "utf8", env, timeout: 60_000 });
  return FOLD_OWNED.filter((rel) => (r.stdout ?? "").includes(`${rel}: adopted (`));
}

const MAX_ROW_FILES = 200;

/**
 * One `commit` row for a commit that landed (STATVS ISA F17). The record is required lazily so the hooks that import
 * this file for parseArgs never load STATVS, and a broken record cannot turn a landed commit into a failure.
 */
function recordCommit(repo: string, sha: string, subject: string, files: string[], mode: "paths" | "staged"): string {
  invariant(/^[0-9a-f]{40}$/.test(sha), "recordCommit needs the full sha of a commit that landed");
  try {
    const { append } = require("../STATVS/index") as typeof import("../STATVS/index");
    const session = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || undefined;
    // The record refuses a bare 40-hex run as credential-shaped; a value under a key ending in sha1 is read as a digest
    // (turn rows' head_sha1 does the same), so the full id lives in data and the envelope ref carries the 12-char prefix.
    const r = append({
      writer: "tool:CommitOwn", stream: "commit", kind: "commit", title: subject.slice(0, 200), session, ref: sha.slice(0, 12),
      data: { repo, commit_sha1: sha, mode, file_count: files.length, files: files.slice(0, MAX_ROW_FILES) },
    });
    if (r.ok) return "recorded";
    return "spooled" in r ? `spooled: ${r.reason}` : `refused: ${r.refused}`;
  } catch (e) {
    return `unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Commit HEAD plus the shared index's entries for `paths`, built in a temporary index so nothing else rides along. */
function commitStaged(repo: string, paths: string[], messages: string[]): { ok: boolean; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "commitown-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    const seeded = git(repo, ["read-tree", "HEAD"], undefined, env);
    if (!seeded.ok) return seeded;
    for (const p of paths) {
      const entries = list(git(repo, ["ls-files", "-s", "-z", "--", p]).out);
      if (entries.some((e) => !/^\d+ [0-9a-f]+ 0\t/.test(e))) return { ok: false, out: "", err: `${p} has unresolved conflicts in the index` };
      const r = entries.length
        ? git(repo, ["update-index", "--add", "--cacheinfo", [...entries[0].split("\t")[0].split(" ").slice(0, 2), p].join(",")], undefined, env)
        : git(repo, ["update-index", "--force-remove", "--", p], undefined, env);
      if (!r.ok) return r;
    }
    const ours = list(git(repo, ["diff", "--cached", "HEAD", "--no-renames", "--name-only", "-z"], undefined, env).out);
    invariant(ours.every((f) => paths.includes(f)), "commitOwn --staged built an index with paths it was not given");
    return git(repo, ["commit", "-q", ...messages.flatMap((m) => ["-m", m])], undefined, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function commitOwn(paths: string[], messages: string[], cwd = process.cwd(), opts: { force?: boolean; staged?: boolean } = {}): CommitOwnResult {
  const fail = (code: 1 | 2 | 3, error: string, extra: Partial<CommitOwnResult> = {}): CommitOwnResult => ({ ok: false, code, repo: null, commit: null, files: [], left_staged: [], error, ...extra });
  if (!paths.length) return fail(2, "name at least one path after --");
  if (!messages.length || !messages[0].trim()) return fail(2, "a commit message (-m) is required");
  if (opts.force && opts.staged) return fail(2, "--force and --staged do not combine");

  // Resolve symlinks in the directory part (macOS /var is /private/var, ~/.claude/LIFEOS/USER is a symlink),
  // so each path compares against the repository root git reports.
  const abs = paths.map((p) => { const a = resolve(cwd, p); const d = existingDir(a); return resolve(realpathSync(d), relative(d, a)); });
  const roots = new Set(abs.map((p) => git(existingDir(p), ["rev-parse", "--show-toplevel"]).out));
  if (roots.has("")) return fail(2, "a path is not inside a git repository");
  if (roots.size !== 1) return fail(2, `paths span ${roots.size} repositories; commit each separately`);
  const repo = [...roots][0];

  // Each path is addressed from its own directory: on a case-insensitive disk the on-disk spelling of a parent can
  // differ from the tracked one (USER/WORKFLOWS vs Workflows), and a name relative to the directory resolves either way.
  const local = abs.map((p) => ({ dir: existingDir(p), name: existsSync(p) ? basename(p) : relative(existingDir(p), p) }));

  // Mark new files intent-to-add. It records no content, so a peer's plain commit cannot take them.
  const added: string[] = [];
  for (const { dir, name } of local) {
    if (opts.staged || !existsSync(resolve(dir, name))) continue;
    const fresh = list(git(dir, ["ls-files", "--others", "--full-name", "-z", ...(opts.force ? [] : ["--exclude-standard"]), "--", name]).out);
    if (!fresh.length) continue;
    const r = git(dir, ["add", "-N", ...(opts.force ? ["-f"] : []), "--", name]);
    if (!r.ok) { if (added.length) git(repo, ["reset", "-q", "--", ...added]); return fail(1, `git add -N failed for ${resolve(dir, name)}: ${r.err}`, { repo }); }
    added.push(...fresh);
  }
  const undo = () => { if (added.length) git(repo, ["reset", "-q", "--", ...added]); };

  // The repository's own spelling of every named file, tracked, deleted or newly added.
  // HEAD's listing too: a file already removed with `git rm` is gone from the index, so ls-files alone dropped
  // the deletion from the commit and left it staged for a peer to sweep up (2026-10-15, a Vera person merge).
  const named = [...new Set(local.flatMap(({ dir, name }) => [
    ...list(git(dir, ["ls-files", "--full-name", "-z", "--", name]).out),
    ...list(git(dir, ["ls-tree", "-r", "--full-name", "--name-only", "-z", "HEAD", "--", name]).out),
  ]))];
  // --no-renames: a deleted file beside a near-copy reads as a rename, and --name-only would then print only the
  // new name, so the deletion silently dropped out of the commit (2026-10-10, skills/Loop folded into HillClimb).
  const changed = named.length ? list(git(repo, ["diff", ...(opts.staged ? ["--cached"] : []), "HEAD", "--no-renames", "--name-only", "-z", "--", ...named]).out) : [];
  if (!changed.length) { undo(); return fail(3, `nothing to commit: the named paths have no ${opts.staged ? "staged " : ""}changes`, { repo }); }

  invariant(changed.every((f) => named.includes(f)), "commitOwn would commit paths it was not given");
  const c = opts.staged ? commitStaged(repo, changed, messages) : git(repo, ["commit", "-q", "--only", ...messages.flatMap((m) => ["-m", m]), "--pathspec-from-file=-", "--pathspec-file-nul"], changed.join("\0") + "\0");
  if (!c.ok) { undo(); return fail(1, `git commit failed: ${c.err || c.out}`, { repo, files: changed }); }

  const files = list(git(repo, ["show", "--no-renames", "--name-only", "-z", "--format=", "HEAD"]).out);
  invariant(files.every((f) => changed.includes(f)), "commitOwn committed paths it was not given");
  invariant(changed.every((f) => files.includes(f)), "commitOwn left a named change out of the commit");
  const adopted = adoptCommittedMemory(repo, files);
  const statvs = recordCommit(repo, git(repo, ["rev-parse", "HEAD"]).out, messages[0].trim(), files, opts.staged ? "staged" : "paths");
  return { ok: true, code: 0, repo, commit: git(repo, ["rev-parse", "--short", "HEAD"]).out, files, left_staged: staged(repo), error: null, ...(adopted.length ? { adopted } : {}), statvs };
}

export function parseArgs(argv: string[]): { messages: string[]; paths: string[]; force: boolean; staged: boolean } | null {
  const messages: string[] = [];
  let force = false, staged = false;
  const sep = argv.indexOf("--");
  if (sep < 0) return null;
  const head = argv.slice(0, sep);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "-m" && head[i + 1] !== undefined) messages.push(head[++i]);
    else if (head[i] === "--force") force = true;
    else if (head[i] === "--staged") staged = true;
    else return null;
  }
  return { messages, paths: argv.slice(sep + 1), force, staged };
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  if (!a) { console.error('usage: bun LIFEOS/TOOLS/CommitOwn.ts -m "subject" [-m "body"] [--force|--staged] -- <path> [<path> ...]'); process.exit(2); }
  const r = commitOwn(a.paths, a.messages, process.cwd(), { force: a.force, staged: a.staged });
  console.log(JSON.stringify(r));
  process.exit(r.code);
}
