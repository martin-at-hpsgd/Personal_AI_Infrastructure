---
version: 1.0.1
---

# Maestro front door

Maestro is a desktop app that runs a fleet of coding agents side by side. It is optional. This page covers the one piece LifeOS adds so that a Claude agent started inside Maestro behaves like a session started with the LifeOS launcher.

## The problem it solves

Maestro runs the `claude` binary directly. Shell functions, aliases and the LifeOS launcher are all skipped, so out of the box a Maestro agent:

- loads `settings.json` hooks and `CLAUDE.md`, because Maestro passes nothing that skips user settings;
- does not get `LIFEOS_SYSTEM_PROMPT.md`, because only the launcher attaches it;
- runs with `--dangerously-skip-permissions` on every spawn, unless the tab is in "standard" or "read-only" mode;
- has background tasks switched off through `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.

## The wrapper

`LIFEOS/MAESTRO/claude.ts` is an executable Bun script. Set it as the custom path under Settings → Providers → Claude Code. On each spawn it:

- attaches `LIFEOS_SYSTEM_PROMPT.md` with `--append-system-prompt-file`;
- folds Maestro's own inline system prompt into the same temp file, after the LifeOS rules, so `claude` only ever receives one system-prompt flag;
- drops `--dangerously-skip-permissions`;
- removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment, the same billing guard the launcher applies;
- clears the background-task switch and sets `CLAUDE_CODE_WORKFLOWS=1`.

Subcommands, `--version` and `--help` pass through untouched. `MAESTRO_WRAPPER_DRYRUN=1` prints the final argument list and exits, which is how the wrapper is tested. `MAESTRO_REAL_CLAUDE` overrides the binary path.

With the skip flag gone, a "full" tab runs on the `settings.json` allow and deny lists, and anything that would need a prompt is denied in print mode. Use the "standard" tab mode when approvals should reach you.

## Network and telemetry

Maestro's local web server starts at every launch and binds all interfaces, authenticated only by a token in the URL. It has no loopback-only setting. Block inbound connections to the app in the macOS firewall, and leave the tunnel and web login off unless you mean to expose it.

Crash reporting and the startup check-in default to on. Both are plain settings (`crashReportingEnabled`, `checkForUpdatesOnStartup`). Cue telemetry is sent only while both the Cue and Usage Stats features are on.

## Files

- Wrapper: `LIFEOS/MAESTRO/claude.ts`
- Maestro data: `~/Library/Application Support/maestro/` (`maestro-settings.json`, `maestro-agent-configs.json`)
