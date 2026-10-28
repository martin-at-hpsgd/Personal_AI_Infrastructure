# SketchDiagram

Turn an idea, architecture, or process from the conversation into a hand-drawn-register Excalidraw diagram on the live canvas.

## Ideal State

- The diagram communicates the idea at a glance: no truncated text, no overlapping shapes, no arrows crossing unrelated elements, ≥40px gaps, fonts ≥16.
- Every text element is verifiably readable: each label's style was set when its shape was created (shape `fontSize`, a stroke color that reads on the fill, a pale fill under a saturated stroke for focal boxes), and `bun ~/.claude/skills/Excalidraw/Tools/ContrastCheck.ts [--bg <backdrop-hex>]` exits 0; this gate is part of done, not optional polish.
- Colors and canvas ground come from the user's palette in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Excalidraw/PREFERENCES.md` when present (a dark canvas ground if the user set one there); the cheatsheet palette is the fallback.
- The final render and handoff is excalidraw.com via `Tools/Share.ts <scene.excalidraw> --bg <ground>` (black-canvas aware), verified in a real browser before the link reaches the user. A scene carrying embedded images ships as the exported `.excalidraw` file instead, because share links drop image bytes.
- Elements carry meaningful custom `id`s (e.g. `"auth-svc"`) so later edits are addressable.
- The user has the canvas URL (live, hand-editable) and, when asked or when the diagram is a deliverable, an exported `.excalidraw` file.
- The scene passed the quality check before being declared done: `describe` checked for overlaps and truncation after each batch, and the visual check judged the excalidraw.com render from `Tools/Share.ts`, because the local canvas mis-renders API-created text (SKILL.md Gotchas). With no browser available, the visual check is named as pending.

## Anti-criteria

- The final render or handoff is never the local canvas screenshot and never the CLI `share`.
- No label is styled by a post-`add` patch or a free-text workaround; the share expansion resets bound labels to their shape's stroke color and `fontSize`.
- Quality-check failures are never glossed over: they are fixed before more elements are added, and a bad render is never passed over.

## Inputs

Verify the idea's shape is clear enough to draw: the components, their relationships, and the diagram's audience. If one interpretation fork would change the drawing, flag it inline (`⚠️ Picking X over Y because R; redirect if wrong`) and proceed; if the request is genuinely unreadable, ask up to 3 questions with a `proceed` override.

## Tool contract

All commands: `bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts <command>`. Full reference: `../References/Cheatsheet.md`.

Core sequence:

```bash
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts add /path/to/elements.json   # batch create (or stdin)
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts describe                     # headless structure check
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts export --out d.excalidraw    # deliverable file
bun ~/.claude/skills/Excalidraw/Tools/Share.ts d.excalidraw --bg <ground>     # render to visually check (and hand off)
```

- Plan the coordinate grid before writing JSON: (0,0) top-left, x right, y down; tiers 80–120px apart; shape width `max(160, labelChars * 12)`.
- For a non-white ground, add an oversized backdrop rectangle FIRST (created first = behind everything; e.g. 8000×5000 centered on the scene) in the ground color, and share with `Share.ts --bg <ground>` so the file color matches. Both are needed — the shared editor doesn't honor the file color alone.
- Mermaid shortcut: when the structure maps cleanly to a flowchart, pipe mermaid source to the `mermaid` command instead of hand-placing (browser tab required).
- Starting fresh on a dirty canvas: `snapshot save` first, then `clear --yes`.
