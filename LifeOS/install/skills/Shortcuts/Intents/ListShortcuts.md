# ListShortcuts

The Shortcuts on this machine, or a yes/no on whether one specific shortcut exists.

## Ideal State

- Every shortcut name on this machine is reported as the JSON array `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts list` prints, filtered (for example by a shared name prefix) when the question is about a subset.
- An existence question is answered by `Shortcuts.ts exists "<name>"`: exit 0 means present, 1 means absent.
- After a BuildShortcut run it confirms the exact expected name registered; for a failing RunShortcut it diffs the target name against the list, watching case and trailing spaces.

## Anti-criteria

- Never reports a shortcut as present on a near-match: a name that differs in case or a trailing space is not the expected name.

## Tool contract

```bash
# all shortcut names (JSON array)
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts list

# filter (e.g. every shortcut sharing one name prefix — substitute yours)
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts list | rg -i "<prefix>"

# exact existence check (exit 0 = present, 1 = absent)
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts exists "<exact name>"
```
