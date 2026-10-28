/**
 * @version 1.0.0
 * subagent-sandbox-wrap.ts — the pure string half of SubagentGitSandbox: how a subagent's Bash
 * command is wrapped so it runs under a macOS `sandbox-exec` profile.
 *
 * The LifeOSHooks plugin carries a byte-identical copy (skills/LifeOSHooks/scripts/SyncCores.ts),
 * because it re-wraps a command a classic PreToolUse hook rewrote, and a hooks module cannot import
 * from outside its folder. hooks/lib/subagent-git-sandbox-core.ts builds the profile and imports
 * `shQuote` from here, so there is one quoting rule.
 *
 * The profile goes inline (`-p`), never as a file: a profile file is something a lane could
 * overwrite between two calls, and an inline profile has nothing on disk to tamper with or fail to
 * write.
 *
 * PURE: no imports, no I/O.
 */

export const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

/** What macOS prints when a process already under a sandbox tries to apply another (codex, SwiftPM, a directly launched Chrome). */
export const NESTED_SANDBOX_FAILURE = "sandbox_apply: Operation not permitted";

/** Single-quote a string for safe embedding in a POSIX shell word. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command a subagent's Bash call runs instead of `command`: the same text, verbatim, as the
 * `-c` script of a fresh shell under the inline profile. The tool's own shell (its snapshot, its
 * cwd) runs outside the sandbox; only the command is confined, and its exit status passes through.
 */
export function wrapInline(command: string, profile: string, shell = "/bin/zsh"): string {
  return `${SANDBOX_EXEC_BIN} -p ${shQuote(profile)} ${shell} -c ${shQuote(command)}`;
}
