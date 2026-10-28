# ComputerUse

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ComputerUse/Config.md && echo ok · required for the vision leg

## What it does

ComputerUse is the front door for driving your Mac. Anything with a handle (a web page, an accessibility element, a command line, an API) goes to the Interceptor skill. Only pixel-only work, such as a canvas or an app with no scripting, goes to a vision agent: OpenAI's computer-use model through `codex exec`, or Claude acting through Interceptor's bridge. Every vision run is supervised by `Tools/Run.ts` under a deny list, step and time caps, and a verifier command whose exit code alone decides pass or fail. Routing to Interceptor needs none of the setup below; only the vision leg does.

## Fill in

A `Config.md` at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ComputerUse/Config.md` (under `$CLAUDE_CONFIG_DIR`, else `~/.claude`). Copy it from `skills/ComputerUse/Config.example.md`. Without the file the runner refuses to start a vision run (exit 2), so write it before your first run; empty deny lists in a file you wrote are accepted. One `key: value` line each, lists comma-separated, unknown keys ignored. Smallest useful example, with made-up app names:

```
deny_running: ExamplePasswordManager, Keychain Access
deny_visible: Messages, ExampleChat, Mail
deny_domains: bank.example, brokerage.example
step_cap: 60
wall_clock_seconds: 600
```

| Field | Meaning |
|---|---|
| `deny_running` | Apps that must not be running at all during a vision run (credential stores). |
| `deny_visible` | Apps that must not be running and visible (messaging, mail). Hidden with Cmd+H is fine. |
| `deny_domains` | Browser tab hosts that block the run, matched by hostname suffix. |
| `step_cap`, `wall_clock_seconds`, `poll_ms` | Run limits the runner enforces. Defaults 60, 600 and 1000. A step is a completed computer-use tool call, which can bundle several actions; the wall clock is the hard bound. |
| `focus_on_shortcut`, `focus_off_shortcut` | Names of macOS Shortcuts that turn a Focus mode on and off around a run, so banners stay out of the frames. Optional. |
| `vision_pick` | Which vision leg per target app, such as `default=astra, textedit=claude`. Written from the bake-off, `astra` when absent. |

Install the pieces the vision legs depend on:

- Interceptor, working. The runner refuses to start (exit 4) when its preflight fails.
- For the OpenAI leg: the Codex desktop app, then its computer-use plugin. The command-line tool alone shows no computer-use tool. Run `codex app`, then `codex plugin add computer-use@openai-bundled`.
- Per-app approval, once per target app: open an interactive `codex` session, let it use the app, and choose "Always allow". Headless runs auto-deny an app you never approved.
- macOS Screen Recording and Accessibility permission for the `codex` process. Only you can grant these, in System Settings.
- For the Claude leg: the `claude` command, logged in.

## Accounts and secrets

No keys in `~/.claude/.env`. The OpenAI leg uses your Codex login (a ChatGPT plan or an OpenAI account, signed in through the Codex app or `codex login`); the Claude leg uses your Claude subscription. The runner spawns codex with its own isolated `CODEX_HOME`, so your personal Codex instructions and hooks never reach the model.

## Prove it works

```bash
cd ~/.claude && bun skills/ComputerUse/Tools/Run.ts --dry-run --app TextEdit
grep -nE '^(deny_running|deny_visible|deny_domains):' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ComputerUse/Config.md
codex features list
```

Success: the dry run reads your `Config.md`, checks the deny list and Interceptor, and prints `dry-run: would spawn codex exec ...` with the app allowlist in it, then exits 0 without starting anything. If it prints `refused: deny list` followed by app names, those apps are running or visible: quit or hide them (Cmd+H) and run it again. `refused: Interceptor preflight failed` means Interceptor is not healthy. The second command prints your deny lines. In the third, look for `computer_use` listed as stable and true. For a live end-to-end check of the OpenAI leg, run `bun skills/ComputerUse/Tools/Probe.ts --app TextEdit` from `~/.claude` with TextEdit open on a window: it types a line and saves `cu-probe.txt` in Downloads, and it controls your screen while it runs.
