# Prompting

Status: bun ~/.claude/skills/Prompting/Tools/RenderTemplate.ts --help >/dev/null && echo ok · optional

## What it does

The prompting skill is a library for writing, tightening and composing prompts. The standards (`Standards.md`) need nothing but reading. Two tools turn a Handlebars template plus a data file into a finished prompt: `RenderTemplate.ts` renders one, and `ValidateTemplate.ts` checks that a template is well formed and that its data covers its variables. Those two tools import the `handlebars` and `yaml` packages, so they are the only part that needs setup. The output is always a prompt to use elsewhere, never the final content.

## Fill in

Nothing to write in a file. Both packages, `handlebars` and `yaml`, are declared in the root `package.json` and arrive with the install's `bun install`; if you skipped that, run `cd ~/.claude && bun install`. To keep your own presets, put them under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Prompting/` with a `PREFERENCES.md`, which overrides the skill's defaults. Example data for the shipped templates is in `Templates/Data/` (`Agents.yaml`, `ValidationGates.yaml`, `VoicePresets.yaml`), and the building blocks are `Templates/Primitives/` (`Briefing.hbs`, `Gate.hbs`, `Roster.hbs`, `Structure.hbs`, `Voice.hbs`).

## Accounts and secrets

None. The skill calls no service and reads no `~/.claude/.env` key. If a run stops with `Cannot find package 'handlebars'`, the root `bun install` has not run yet.

## Prove it works

```bash
cd ~/.claude && bun skills/Prompting/Tools/RenderTemplate.ts --help
bun skills/Prompting/Tools/ValidateTemplate.ts -t skills/Prompting/Templates/Primitives/Roster.hbs
```

The first prints the renderer's usage (`LifeOS Template Renderer`) and exits 0. The second is read-only and prints `Status: ✓ Valid` followed by the template's variable list. Both only work once `handlebars` resolves; a missing package stops them at the import. Then render one of the shipped templates, for example `bun skills/Prompting/Tools/RenderTemplate.ts -t skills/Prompting/Templates/Primitives/Roster.hbs -d skills/Prompting/Templates/Data/Agents.yaml`, and expect a Markdown agent roster on stdout.
