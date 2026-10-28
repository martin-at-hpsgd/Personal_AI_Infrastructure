# Calibrate

Status: bun ~/.claude/skills/Calibrate/Tools/Calibrate.ts targets · optional

## What it does

Calibrate shows you real outputs from an eval or a configured target on a local review page, collects your 0–10 scores and notes, measures how well the judge agrees with you, and distills a taste profile the judge reads from then on. Every Assay eval suite works with no setup; image intents join through a target you add with the AddTarget intent.

## Fill in

Both files are optional and live in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Calibrate/` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Templates ship with a fresh install.

| File | Key | Meaning |
|---|---|---|
| `Config.md` | `browser` (frontmatter) | The app `session --open` opens the review page in, for example `Google Chrome` or `Example Browser`; `default` for the system default browser. With no `Config.md` the page opens in the system default browser and the tool warns; a `Config.md` without the key stops the open with an error naming the file and key. |
| `PREFERENCES.md` | free text | What you score first. AddTarget follows it when it writes a target's page question and judge brief. |

Targets, labels, sessions and taste profiles are written by the tool under `Targets/<target>/`; you never edit them by hand (`SKILL.md` § Data & Config).

## Accounts and secrets

None of its own. Rescoring calls the judges the eval already uses: Assay's judge for text suites, and ArtDirection's critique panel for image targets, each on the keys those skills already need.

## Prove it works

```bash
bun ~/.claude/skills/Calibrate/Tools/Calibrate.ts targets
bun ~/.claude/skills/Calibrate/Tools/Calibrate.ts discover "example task" --json
```

`targets` lists your configured targets (`[]` on a fresh install). `discover` ranks the targets and eval suites that match a task in plain words. Both run offline.
