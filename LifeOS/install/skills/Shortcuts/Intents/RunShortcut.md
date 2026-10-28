# RunShortcut

An already-built Shortcut invoked from the CLI, with its result on stdout.

## Ideal State

- The named shortcut runs through `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts run "<name>"` (or an identical direct `shortcuts run "<name>"` call from a consumer), with `--input` piped to the shortcut's stdin when it takes input and `--json` when the result feeds other tools.
- The caller gets whatever the shortcut's final action returns, on stdout (trimmed).
- On a nonzero exit, the report first rules a name mismatch in or out by checking the name against ListShortcuts, and states that result before naming any other cause.

## Anti-criteria

- Running a built shortcut never uses computer use or pixels; it is pure CLI.

## Tool contract

Optional existence check: `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts exists "<name>"`.

```bash
# no input
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts run "<name>"

# with input piped to the shortcut's stdin
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts run "<name>" --input "22"

# structured result for piping into other tools
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts run "<name>" --input "cool" --json
```

The wrapper is `shortcuts run "<name>"` plus exact-name error messages and `--json` framing. A consumer such as a home-control skill's thermostat script may call `shortcuts run` directly; both are fine.
