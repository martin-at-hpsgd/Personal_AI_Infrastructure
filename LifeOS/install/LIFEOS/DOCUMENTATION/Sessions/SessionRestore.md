---
version: 1.0.3
---

# Session Restore

When a terminal dies with several Claude sessions open, one LifeOS command brings them all back. The harness resume command still does the actual resuming; LifeOS only remembers which sessions were open, in which directory, and opens each one in its own tab. Codex sessions are not registered today (see below).

## The registry

`MEMORY/STATE/live-sessions/<session-id>.json`, one file per interactive session:

```json
{ "sessionId": "…", "harness": "claude", "cwd": "/Users/you/Projects/x", "pid": 30538,
  "startedAt": "2026-09-12T18:00:00.000Z", "kitty": { "listenOn": "unix:/tmp/kitty-1", "windowId": "7" } }
```

- Written at SessionStart by `hooks/KittyEnvPersist.hook.ts`. Claude runs that hook natively. The Codex bridge skips it by name (`SKIP_LIST` in `LIFEOS/CODEX/Bridge.ts`), so a Codex session writes no entry and `/rs` cannot bring it back. The registry format and `LiveSessions.ts` already carry a `harness` field and the Codex resume command, for the day that bridge registers. `cwd` comes from the hook input; `pid` is found by walking up from the hook process to the harness process.
- Removed at SessionEnd by `hooks/SessionCleanup.hook.ts`. A killed terminal never reaches SessionEnd, so the file survives. That surviving file is the whole signal.
- Liveness is decided at restore time, never stored: the recorded pid must exist and its argv must still name the harness, so a reused pid does not count as alive.

Code: `LIFEOS/TOOLS/LiveSessions.ts` (registry, liveness, per-harness resume argv, kitty launch argv). No daemon, no heartbeat.

## The command

```
bun LIFEOS/TOOLS/Sessions.ts list [--json]
bun LIFEOS/TOOLS/Sessions.ts restore <id|name|--all> [--dry-run] [--print]
bun LIFEOS/TOOLS/Sessions.ts forget <id> | prune
```

Slash form: `/rs` (restore all), `/rs <id or name>`, `/rs list`.

`restore` opens each dead session in a new kitty tab at its recorded directory with that harness's own resume: Claude through `bun LIFEOS/TOOLS/lifeos.ts -r <id>` (so the system prompt and billing flags match a normal launch). The tool also builds `codex resume <id>` for an entry whose `harness` says so, but no Codex session writes one today. Live sessions are skipped. Outside kitty, or with `--print`, it prints the `cd … && …` lines instead. The kitty socket comes from `KITTY_LISTEN_ON`, then the persisted `kitty-env.json`.

Only sessions started after this shipped are registered; nothing is reconstructed retroactively.

Tests: `bun test ./LIFEOS/TOOLS/Sessions.test.ts` (source tree only; tests are not in the release payload).
