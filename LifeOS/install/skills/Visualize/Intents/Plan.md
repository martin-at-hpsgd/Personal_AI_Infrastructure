# Plan

Lay out a physical plan (a gear setup, a rig, a studio corner, a rack, a room, a purchase list with a shape) as a to-scale top-down drawing plus a grounded HTML page: detail panel, cost split, the full order and the decisions still open.

## Ideal State

- The drawing is to scale and reads at a glance. Every piece sits at its real size in the plan's unit, the front or wall is marked, and a scale bar is shown. Tapping a piece shows its model, size in both units, price and note.
- Nothing is invented. Every piece, order line, category cost, stated total and open decision cites `{ file, quote }`, and the quote appears verbatim in that file. Each cost, stated total and `dims` value appears as a number in its own quote, and the tool refuses one that does not. A mismatch between the category costs and the plan's stated total is shown on the page, never smoothed over.
- Positions are honest. Plans rarely say where things go; `drawing.note` states where the positions came from (the plan, a photo, or a proposed arrangement), and where a drawn footprint (`w`, `d`, `dia` without `dims`) is an estimate rather than a stated size.
- The order is complete. Every line the plan buys appears in a group, including hardware and consumables that are not drawn.
- Open decisions are listed as the plan states them.
- When no document states the plan, the page says that no plan document exists, and the facts drawn from what the principal said are cited as the principal's words.
- Before delivery the page was verified in a real browser through the Interceptor skill and captured, and one piece was clicked and confirmed to fill the panel and highlight.

## Anti-criteria

- The model never hand-writes HTML; `Tools/VisualizePlan.ts` checks every `{ file, quote }` against the plan document and draws the page.
- The plan model is never written inside the skill.
- A refusal is never worked around: on exit 1 the model is fixed or the plan read again, and the check re-run.
- The page is never opened in the principal's own browser unless asked.

## Output format

1. Lead with anything the page surfaced that needs a decision, such as a cost that does not match the stated total.
2. Show the console summary.
3. Give the page's path.

## Inputs

Find the plan's own documents first: an order sheet, a gear inventory, an ISA, a quote. For the principal's gear, the install's gear inventory (for LifeOS, `LIFEOS/USER/GEAR.md`) usually points at the working order sheet. With no document, draw it from what the principal said.

## Safety gates

- Read-only on the plan's documents. The only writes are the page and the plan model.
- No secret values anywhere in the model.

## Tool contract

```bash
# 1. See the model shape and the materials
bun ~/.claude/skills/Visualize/Tools/VisualizePlan.ts --schema

# 2. Validate against the plan's directory (relative source paths resolve there; absolute paths are allowed)
bun ~/.claude/skills/Visualize/Tools/VisualizePlan.ts --check --model <plan.json> --root <plan dir>

# 3. Render: console summary on stdout, page written to <plan dir>/Visualize-<slug>-<YYYY-MM-DD-HHmmss>.html
bun ~/.claude/skills/Visualize/Tools/VisualizePlan.ts --model <plan.json> --root <plan dir>
```

Exit 1 prints every refusal. `--out-dir`, `--no-html` and `--width` behave as in the system map (SKILL.md § Split of work).

- The plan model is the principal's data: write it under `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Visualize/Plans/<slug>.plan.json` so it can be re-rendered when the plan changes.

## Gotchas

- **A plan quote must be verbatim, including the plan's own symbols.** Order sheets write sizes like `22"×18"` with a multiplication sign. The matcher normalizes case, whitespace and curly quotes, but not `x` versus `×`, so copy the quote from the file. (2026-09-24)
