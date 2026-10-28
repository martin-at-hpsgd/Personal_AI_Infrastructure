# Render Intent

Turn the current session's output into a published, verified HTML artifact.

## Ideal State

- One self-contained HTML file renders the session's actual output: real content, verbatim quotes kept verbatim, sources preserved, verification flags preserved.
- The file is rendered by `Tools/Render.ts` from a content JSON, with no hand-authored one-off CSS; content that genuinely did not fit the block types led to an extension of Render.ts (new block type or register) so the next run benefits.
- The register fits the content per the Register choice table.
- When multiple candidate outputs existed, the reply names the one rendered (`⚠️ Rendering X, not Y; redirect if wrong.`).
- The rendered file is published as an Artifact, after the `artifact-design` skill was loaded, and pixel-verified before the URL is handed over: the Artifact `list` action shows it, and a local serve of the HTML file was captured and its pixels viewed.
- The artifact URL is handed over with a one-line description of what it contains.

## Anti-criteria

- Never invents content: when the session contains no substantive output to render (nothing analyzed, researched, or produced yet), it says so and asks what to render.
- Never hand-styles a one-off: no hand-authored one-off CSS outside `Tools/Render.ts`.
- Never hands over the artifact URL before both legs, publication and render, are verified.

## Tool contract

```bash
bun ~/.claude/skills/HTML/Tools/Render.ts --schema      # content JSON shape + example
bun ~/.claude/skills/HTML/Tools/Render.ts --registers   # available registers
bun ~/.claude/skills/HTML/Tools/Render.ts \
  --json <content.json> \
  --register <dossier|ledger> \
  --out <artifact.html>
```

Publishing and verifying the rendered file:

- Publish with the Artifact tool; reusing the same file path updates the existing artifact at its URL.
- Render leg: serve the HTML file locally (`bunx serve`) and capture it through the Interceptor skill's sanctioned screenshot path, because the artifact URL 404s outside the owner's signed-in session (SKILL.md Gotchas). Publication leg: the Artifact `list` action.

Block types: `prose`, `callout`, `quote` (id + badge + quote/text + note + source), `list` (bold lead-ins), `cut` (strikethrough + stamp — for disclosed rejections), `table`, `group` (era/category separators). Badges listed in the register's `badgeSolid` render filled; others outlined.

### Register choice

| Content | Register | Look |
|---------|----------|------|
| Evidence file, red team, investigation, claim testing | `dossier` | dark ink-green / orange, condensed display + typewriter |
| Report, plan, comparison, metrics, finance | `ledger` | dark navy / gold, old-style serif |

Content fit picks the register. For a new look, add a register to Render.ts rather than hand-styling a one-off.
