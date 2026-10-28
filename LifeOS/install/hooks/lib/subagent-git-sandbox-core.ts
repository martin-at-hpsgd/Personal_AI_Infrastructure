// subagent-git-sandbox-core.ts — a shell-free guarantee that a subagent's Bash command cannot
// alter the git internals of the private trees (~/.claude, ~/.config/LIFEOS/USER).
//
// WHY THIS EXISTS. SubagentShipGuard protects those git internals by statically modelling which
// directory a shell command runs in. Three review rounds in a row found fail-opens in that model
// (nested shells, -C chains, subshell cds, computed output paths), and three remained open after
// 2.4.4: a cd that `&&`/`||`/`if` may skip, a commented-out cd, and a redirect to a computed path.
// Static shell parsing cannot be made complete, so this layer stops parsing and enforces at the
// filesystem: a macOS `sandbox-exec` deny-write profile wrapping the subagent's Bash command, with
// a before/after integrity check as the fallback when sandbox-exec is unavailable.
//
// POLICY (what a lane may and may not do under this layer):
//   - DENY every write under each private tree's `.git`: config, hooks, refs, HEAD, packed-refs,
//     logs, info, modules — the integrity surface. However the write is spelled, the OS refuses it
//     by the resolved path, so the parser's cwd model no longer matters.
//   - ALLOW `.git/objects/**`, `.git/index` and `.git/index.lock`. A lane legitimately runs
//     `git add <path>` (the guard allows it; it is in settings.allow), which writes a loose object
//     and the index. Index pollution cannot reach a commit: SubagentShipGuard and the plugin both
//     refuse a subagent commit in a private tree, and the main session's CommitOwn stages explicit
//     paths with `git commit --only`. Objects are content-addressed and inert until a ref (denied)
//     points at them. Leaving these two writable changes nothing a lane can do today.
//   - Read-only git (status, log, diff, show) keeps working: `git status` degrades gracefully when
//     it cannot refresh its stat cache, and here the index is writable anyway.
//
// This module is pure and has no side effects beyond reading the filesystem. It parses no shell.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SANDBOX_EXEC_BIN, shQuote } from "./subagent-sandbox-wrap";
import { defaultClaudeDir, getClaudeDir, getLifeosDir } from "./paths";

export { shQuote };
export const SANDBOX_EXEC = SANDBOX_EXEC_BIN;

/**
 * The private trees whose git internals a lane must never alter: the install's config root
 * (getClaudeDir(), which follows CLAUDE_CONFIG_DIR / the plugin root), the HOME profile's default
 * config root, the USER data repo at its HOME default, and wherever <lifeos>/USER really lives.
 * A deny-side boundary, so the set is a union: a relocated install adds its own tree and never
 * drops the HOME profile's. gitDirs() skips any root without a .git.
 */
export function privateTreeRoots(home = homedir()): string[] {
  const roots = [getClaudeDir(), defaultClaudeDir(home), join(home, ".config", "LIFEOS", "USER")];
  try {
    roots.push(realpathSync(join(getLifeosDir(), "USER")));
  } catch {
    /* no USER tree at the resolved root (fresh install): nothing more to protect */
  }
  return [...new Set(roots)];
}

/**
 * Resolve each private tree's real `.git` directory, following a `.git` gitdir file (worktrees)
 * and symlinks. A tree whose `.git` is missing or unreadable is skipped — the caller treats an
 * empty result as "mechanism cannot be built" and fails closed for the protected paths.
 *
 * A worktree's `.git` is a pointer FILE naming its gitdir. The pointer itself is returned too
 * (realpathed), ahead of the gitdir it names: rewriting it repoints the tree at any git dir, with
 * any config and hooks, so it is integrity surface like the dir it names (P1 batch 2, S032).
 * sandboxProfile denies its subpath, which covers the one file; hashIntegritySurface hashes it.
 */
export function gitDirs(roots = privateTreeRoots()): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const dotgit = join(root, ".git");
    if (!existsSync(dotgit)) continue;
    try {
      const st = statSync(dotgit);
      if (st.isDirectory()) {
        out.push(realpathSync(dotgit));
        continue;
      }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"));
      // The pointer file is protected whether or not its contents parse: a write that fixes or breaks
      // it changes which git dir the tree uses.
      out.push(realpathSync(dotgit));
      if (m) {
        const p = m[1]!;
        const gitdir = realpathSync(isAbsolute(p) ? p : join(root, p));
        out.push(gitdir);
        // A worktree's gitdir holds only its own HEAD, index and logs; config, hooks and refs live in the shared
        // common dir its `commondir` file names. Protect that too.
        const common = commonDirOf(gitdir);
        if (common) out.push(common);
      }
    } catch {
      /* unreadable .git → skip; the hook reports the mechanism unavailable for this tree */
    }
  }
  // De-dup (the two trees never share a .git, but a mis-set gitdir could).
  return [...new Set(out)];
}

/**
 * The real common git dir a worktree gitdir points at through its `commondir` file (relative to the gitdir, or
 * absolute), or null when the gitdir has none (a plain repo's .git is its own common dir). A commondir that names
 * nothing resolvable is null: git cannot operate in that worktree either.
 */
export function commonDirOf(gitdir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(gitdir, "commondir"), "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const common = realpathSync(isAbsolute(raw) ? raw : join(gitdir, raw));
    return statSync(common).isDirectory() && common !== gitdir ? common : null;
  } catch {
    return null;
  }
}

/** SBPL string-literal escaping: backslash and double quote. */
function sbplEsc(p: string): string {
  return p.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * A macOS sandbox profile (SBPL) that allows everything by default, denies all writes under each
 * given `.git`, then re-allows `objects`, `index` and `index.lock` within it. SBPL applies the
 * last matching rule, so the re-allow overrides the deny for those paths only.
 */
export function sandboxProfile(gitdirs: string[]): string {
  const lines = ["(version 1)", "(allow default)"];
  for (const g of gitdirs) lines.push(`(deny file-write* (subpath "${sbplEsc(g)}"))`);
  const allows: string[] = [];
  for (const g of gitdirs) {
    allows.push(`(subpath "${sbplEsc(g)}/objects")`, `(literal "${sbplEsc(g)}/index")`, `(literal "${sbplEsc(g)}/index.lock")`);
  }
  if (allows.length) lines.push(`(allow file-write* ${allows.join(" ")})`);
  return lines.join("\n") + "\n";
}

/**
 * Wrap a command so it runs under a deny-write profile already written to `profilePath`. The original
 * command is embedded verbatim in `zsh -c '<cmd>'`; the shell's own startup runs OUTSIDE the sandbox,
 * so only the command itself is confined.
 *
 * NOT the live path. A live subagent call is wrapped by `wrapInline` (subagent-sandbox-wrap.ts) with
 * the profile inline, because a profile file is something a lane could overwrite between two calls.
 * This file form serves only the hook's unregistered classic entry point and the tests that drive the
 * real sandbox-exec against a scratch profile; nothing that confines a lane may call it.
 *
 * IMPORTANT: feed SubagentShipGuard the ORIGINAL command, never this wrapped form — the guard's
 * cwd model mis-reads the nested `zsh -c` payload and would loosen. The wrap is applied only after
 * the guard has already judged the original (see sandbox-wiring.md for the composition contract).
 */
export function wrapUnderSandbox(command: string, profilePath: string, shell = "/bin/zsh"): string {
  return `${SANDBOX_EXEC} -f ${shQuote(profilePath)} ${shell} -c ${shQuote(command)}`;
}

/** Whether the OS mechanism is present. A missing binary means the hook falls back to detection. */
export function sandboxAvailable(): boolean {
  try {
    return existsSync(SANDBOX_EXEC) && statSync(SANDBOX_EXEC).isFile();
  } catch {
    return false;
  }
}

// --- Fallback: before/after integrity check (detect + alert, never auto-restore) ------------------

/**
 * Files and directories within a `.git` that form the integrity surface (everything but objects/index).
 * The sandbox profile denies the whole `.git` subpath, so this list is what the fallback must match: the worktree
 * config (`config.worktree`), the worktree's pointer to the shared git dir (`commondir`) and back (`gitdir`),
 * `shallow`, and the `modules` and `worktrees` trees all change where git reads its config, hooks and refs from.
 */
const SURFACE_ENTRIES = ["config", "config.worktree", "HEAD", "packed-refs", "commondir", "gitdir", "shallow"] as const;
const SURFACE_DIRS = ["hooks", "refs", "logs", "info", "branches", "modules", "worktrees"] as const;

function walkFiles(dir: string, acc: string[], budget = { n: 20000 }): void {
  let ents: string[];
  try {
    ents = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of ents) {
    if (budget.n-- <= 0) return;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      acc.push(p + "\0<unstat>");
      continue;
    }
    if (st.isDirectory()) walkFiles(p, acc, budget);
    else acc.push(p);
  }
}

/**
 * A content hash of each private tree's integrity surface. Compare the map from before a subagent
 * Bash command with the map from after: any added, removed or changed key is an unauthorized change.
 * Pure read; never writes, never restores.
 */
export function hashIntegritySurface(gitdirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of gitdirs) {
    // A worktree's `.git` pointer file (gitDirs returns it beside the dirs): its own bytes are the surface.
    let isFile = false;
    try {
      isFile = statSync(g).isFile();
    } catch {
      /* gone or unreadable: the entries below record nothing, and diffSurface sees the key vanish */
    }
    if (isFile) {
      try {
        out.set(g, createHash("sha256").update(readFileSync(g)).digest("hex"));
      } catch {
        out.set(g, "<unreadable>");
      }
      continue;
    }
    for (const e of SURFACE_ENTRIES) {
      const p = join(g, e);
      try {
        if (existsSync(p)) out.set(p, createHash("sha256").update(readFileSync(p)).digest("hex"));
      } catch {
        out.set(p, "<unreadable>");
      }
    }
    for (const d of SURFACE_DIRS) {
      const base = join(g, d);
      const files: string[] = [];
      walkFiles(base, files);
      for (const f of files.sort()) {
        try {
          out.set(f, createHash("sha256").update(readFileSync(f)).digest("hex"));
        } catch {
          out.set(f, "<unreadable>");
        }
      }
    }
  }
  return out;
}

/** Paths that differ between two surface snapshots (added, removed, or content-changed). */
export function diffSurface(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [p, h] of after) if (before.get(p) !== h) changed.push(p);
  for (const p of before.keys()) if (!after.has(p)) changed.push(p);
  return [...new Set(changed)].sort();
}
