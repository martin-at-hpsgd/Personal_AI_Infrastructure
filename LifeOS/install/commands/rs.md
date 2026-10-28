---
name: rs
description: Restore sessions — bring back every Claude session a killed terminal took with it, or one by id or name, each in its own tab at its own directory. Bare "rs" means restore all.
argument-hint: [id | name | --all | list]
version: 1.0.2
---

# rs — Restore sessions

The principal typing `/rs` (or a bare `rs`) means: bring back the sessions that died with the terminal. The registry is `MEMORY/STATE/live-sessions/`; the tool is `LIFEOS/TOOLS/Sessions.ts`.

- `/rs` or `/rs --all` → `bun LIFEOS/TOOLS/Sessions.ts restore --all`. Every registered session whose harness process is gone comes back in a new kitty tab, at its recorded directory, on Claude's own resume (the `lifeos -r` launcher). Codex sessions are not registered today, so `/rs` does not bring them back. Sessions still running are skipped, never duplicated.
- `/rs <id or name>` → `restore <query>`. A session id prefix or a unique substring of the session name.
- `/rs list` → `list`. Show what is registered and which entries are dead.

Run the command, then report what came back and what was skipped, in the standard format. Outside kitty the tool prints the commands instead of opening tabs; relay them verbatim in a code block.
