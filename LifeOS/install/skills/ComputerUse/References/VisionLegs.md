# Vision legs

How each vision leg is spawned and confined. Both run under the shared `supervise()` in `Tools/Run.ts` described in `SKILL.md` § The supervised run; this file holds only what differs per leg.

## Astra leg

- Spawned as a child process with an argument array: `--ephemeral`, `--sandbox read-only` in a scratch directory, `browser_use` and `browser_use_full_cdp_access` disabled by config override, this skill's `Instructions.md` replacing the codex default, the model from `LIFEOS/TOOLS/models.ts` lane `computerUse`.

## Claude leg

- `Tools/ClaudeLeg.ts` (`Run.ts --backend claude`). Each step: screenshot the target app's window through the bridge, ask `claude --print` for one JSON action, run it as `interceptor macos <verb> --app <target>`.
- The model has no shell, no MCP, no settings: `--tools Read --restricted --safe-mode --strict-mcp-config`, Read confined to that step's screenshot directory. Unknown verbs end the run.
- Subscription billing: the child's env drops `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDECODE`, mirroring `LIFEOS/TOOLS/Inference.ts`.
- Its actions are bridge verbs chosen by Claude's vision, not Anthropic's trained computer-use tool format (that lives in the desktop app and the API), so its bake-off scores measure this setup only.
- Screenshot pixels map to global points via the window frame from `Tools/WindowBounds.ts` (CoreGraphics, read-only).
