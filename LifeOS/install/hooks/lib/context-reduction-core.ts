/**
 * @version 1.0.6
 * context-reduction-core.ts — the RTK auto-rewrite rules as a pure function.
 *
 * A TypeScript port of ContextReduction.hook.sh (git/gh status-path rewrites plus
 * the interceptor-screenshot cwd redirect), byte-for-behavior, so the LifeOSHooks
 * plugin can run the rewrite as a typed `tool.call` hook and the 40-probe suite
 * can run against a function instead of a spawned shell. The shell hook stays
 * the command-hook path; both must agree — ContextReduction.test.ts pins the
 * shell, skills/LifeOSHooks/tests/context-reduction.test.ts pins this (source tree only; tests do not ship).
 *
 * INVARIANT (2026-06-10, do not regress): only rewrite when the rtk subcommand is a
 * transparent passthrough to the SAME binary AND parse failure falls back to identical
 * semantics. NEVER rewrite read-path commands whose stdout the model reasons over as
 * evidence — search (rg/grep), file reads (cat/head), listings (ls/tree/find), diffs,
 * HTTP (curl/wget), queries (psql/aws). Compress what the model WATCHES (VCS status,
 * gh metadata); never what it READS. Incident: 2026-06-10 ISA miss.
 *
 * PURE: no imports, no I/O. Whether `rtk` is on PATH is the caller's question.
 */

// diff/show/log are READ paths (rtk caps hunks at 100 lines, drops patch headers
// and commit bodies): excluded per the INVARIANT (public issue #2209, @corobis).
// Mirrors ContextReduction.hook.sh since its 2026-07-13 shrink: status, and branch with listing flags only.
// Mutations (add, commit, push, pull, fetch, stash) run raw: rtk in front of a push reads as a wrapper the
// public-push gate cannot vouch for, and nothing about a mutation needs compressing (2026-10-21).
const GIT_STATUS_SUBCOMMANDS = /^status(\s|$)/;
const BRANCH_LISTING_FLAGS = new Set(["-a", "-r", "-v", "-vv", "-l", "--all", "--remotes", "--verbose", "--list", "--show-current", "--no-color", "--color"]);
const isBranchListing = (sub: string) => /^branch(\s|$)/.test(sub) && sub.split(/\s+/).slice(1).filter(Boolean).every((a) => BRANCH_LISTING_FLAGS.has(a));
/** Control, pipe, substitution and redirection characters: any one means not a simple command. */
const SHELL_CONTROL_RE = /[;&|`$<>()\\]/;
const ENV_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*=[^ ]* +)+/;

/** The rewritten command, or null when the command is left as it is. */
export function rewriteCommand(cmd: string): string | null {
  if (!cmd) return null;
  // Already rtk, heredocs, multi-line scripts: never touched (byte-offset rules
  // below assume single-line semantics).
  if (/^rtk /.test(cmd) || /\/rtk /.test(cmd)) return null;
  if (cmd.includes("<<")) return null;
  if (cmd.includes("\n")) return null;
  // Simple single commands only (2026-10-13 audit, finding 17): the shell hook
  // emits permissionDecision "allow" for the whole string, so a compound such as
  // `git status; <anything>` must never be rewritten (and thereby approved).
  if (SHELL_CONTROL_RE.test(cmd)) return null;

  const envMatch = cmd.match(ENV_PREFIX_RE);
  const envPrefix = envMatch ? envMatch[0] : "";
  const body = cmd.slice(envPrefix.length);
  const match = body;

  // git (status-path only — see INVARIANT)
  if (/^git\s/.test(match)) {
    const sub = match
      .replace(/^git\s+/, "")
      .replace(/(-C|-c)\s+\S+\s*/g, "")
      .replace(/--[a-z-]+=\S+\s*/g, "")
      .replace(/--(no-pager|no-optional-locks|bare|literal-pathspecs)\s*/g, "")
      .replace(/^\s+/, "");
    if (GIT_STATUS_SUBCOMMANDS.test(sub) || isBranchListing(sub)) return `${envPrefix}rtk ${body}`;
    return null;
  }

  // gh (pr/issue/run/api/release metadata — read-path bodies excluded)
  if (/^gh\s+(pr|issue|run|api|release)(\s|$)/.test(match)) {
    return `${envPrefix}${body.replace(/^gh /, "rtk gh ")}`;
  }

  // interceptor screenshot --save — redirect output to the user's own cache dir (0700), never the
  // shared /tmp: these are screenshots of the principal's authenticated pages (round-21 audit).
  if (/^interceptor\s+screenshot(\s|$)/.test(match) && /--save/.test(match)) {
    return `${envPrefix}mkdir -p "\${XDG_CACHE_HOME:-$HOME/.cache}/lifeos-screenshots" && chmod 700 "\${XDG_CACHE_HOME:-$HOME/.cache}/lifeos-screenshots" && ( cd "\${XDG_CACHE_HOME:-$HOME/.cache}/lifeos-screenshots" && ${body} )`;
  }

  return null;
}
