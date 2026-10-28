# Visualize

Status: bun ~/.claude/skills/Visualize/Tools/Visualize.ts --schema >/dev/null && echo ok · optional

## What it does

Turns anything you want to see (a codebase, a physical setup, a timeline, a process, a concept) into a short console summary plus one self-contained HTML page, with every fact labelled by where it came from. It works out of the box with no configuration; the files below only change taste and keep your saved plans.

## Fill in

Everything lives under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Visualize/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). All of it is optional; with none of it the skill uses its defaults.

**1. `PREFERENCES.md`**, read by the intents at run time. No tool parses it.

| Section → key | Meaning | Default when absent |
|---|---|---|
| `## Concept pages` → `Ground:` | The page ground every Concept page uses, e.g. "dark or saturated" or "off-white paper". | Each page picks the ground that suits its subject. |

The installer puts a filled example at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Visualize/PREFERENCES.md`; if it is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited.

**2. `Plans/<slug>.plan.json`**, written by the Plan intent, one per physical plan (a desk, a rack, a kit). Each piece, order line, cost and decision quotes the source document it came from, so the plan can be re-rendered when that document changes. `bun ~/.claude/skills/Visualize/Tools/VisualizePlan.ts --schema` prints the shape.

## Accounts and secrets

None. Baking a page into a static image (`Tools/Bake.ts`) drives a real browser through the Interceptor skill's `skills/Interceptor/Tools/VerifyViewport.ts`, so that one step needs Interceptor set up; everything else runs on Bun alone.

## Prove it works

```bash
bun ~/.claude/skills/Visualize/Tools/Visualize.ts --schema       # prints the system-model shape, exit 0
bun ~/.claude/skills/Visualize/Tools/VisualizePlan.ts --schema   # prints the plan-model shape, exit 0
bun test ~/.claude/skills/Visualize/Tools                         # renderer tests pass
```

To check a saved plan still matches its source document: `bun ~/.claude/skills/Visualize/Tools/VisualizePlan.ts --check --model <your Plans/<slug>.plan.json> --root <folder holding the document>` prints `plan ok`, or names each quote that no longer appears.
