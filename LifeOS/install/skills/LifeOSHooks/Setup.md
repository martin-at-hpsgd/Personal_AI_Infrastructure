# LifeOSHooks

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOSHooks/Config.md && echo ok · optional

## What it does

LifeOSHooks is the in-process half of the LifeOS hook system: one hooks module that Claude Code's function-hook runtime loads once per interactive session. The skill checks that the module is armed, explains why a line or banner did or did not draw, refreshes its type declarations after a Claude Code update, and keeps its pure-core copies equal to their sources. The module itself holds no personal data. The one thing that differs between installs is how the plugin is loaded, which decides whether a saved edit reaches an open session on its own or only after `/reload-plugins`. The skill reads that from your Config.md before it answers a reload question.

## Fill in

One optional file, `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOSHooks/Config.md` (under `$CLAUDE_CONFIG_DIR`, else `~/.claude`). The release ships a template with made-up values. It is prose the skill reads, not a file any code parses, so keep the headings and fill each line in plain words.

If you load the plugin straight from the skills folder (`LifeOSHooks@skills-dir`, the default when the folder sits under `skills/`), you can delete the file: every save then hot-reloads the module in every open session, and the skill assumes that when the file is absent.

If you load it from a folder marketplace, fill in each line:

| Line | Meaning | Example |
|---|---|---|
| Marketplace | The name you gave the folder marketplace in `claude plugin marketplace add <folder>`. | `example-local` |
| Mods loaded from it | Every `<plugin>@<marketplace>` you installed from that marketplace, this hooks module first, plus any other mods (such as RichFormat) it lists. | `LifeOS@example-local`, `rich-format@example-local` |
| Skills-folder copies disabled in settings.json | Each `<name>@skills-dir` copy you disabled so the module never loads twice. | `LifeOSHooks@skills-dir` |
| Consequence | What a saved edit does to an open session under this topology. For a folder marketplace: nothing until `/reload-plugins` in that session, and `claude plugin update` reports "nothing to update". | as shown |

The release leaves out Claude Code's own plugin declarations (`.claude/types/claude-code.d.ts` and `claude-code-plugins.d.ts`); the module runs without them. To typecheck it, generate your own from the Claude Code build you run: its `plugin-authoring` skill provides that build's declarations when it loads; put them at `.claude/types/claude-code.d.ts`.

## Accounts and secrets

None. The plugin needs no key, token or account beyond your Claude Code login. Its one user setting is `forceBackground` in its plugin manifest (`.claude-plugin/plugin.json`, or the marketplace entry when the install keeps the manifest there), off by default.

## Prove it works

```bash
claude plugin validate ~/.claude/skills/LifeOSHooks
claude -p "Reply OK." --plugin-dir ~/.claude/skills/LifeOSHooks --debug-file "${TMPDIR:-/tmp}/lifeoshooks-probe.log" --max-turns 1
grep -E "settled|failed to load" "${TMPDIR:-/tmp}/lifeoshooks-probe.log"
```

Success: the validate command lists the hooked events with no error, and the debug log has a `settled` line and no `failed to load` line. In an open interactive session after a change, run `/reload-plugins` first when Config.md says the plugin loads from a marketplace.
