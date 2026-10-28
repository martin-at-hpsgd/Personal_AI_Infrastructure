# AnimatedDiagram.ts

A TechnicalDiagrams diagram that draws itself, delivered as a looping GIF. Vector strokes generated from a spec, animated on the HyperFrames seam, encoded to GIF.

## Commands

```bash
bun ~/.claude/skills/Art/Tools/AnimatedDiagram.ts build --spec <diagram.json> --dir <project> [--force]
bun ~/.claude/skills/Art/Tools/AnimatedDiagram.ts gif   --dir <project> [--name <slug>] [--width 1200] [--fps 15]
```

- `build` writes `<project>/index.html` (a seam-contract composition), `<project>/diagram.json` (the spec plus its computed `duration` and `holdStart`), and stages GSAP. It prints when the complete diagram starts holding; take stills there with the seam's `snapshot`.
- `gif` renders `Out/<slug>.mp4` through the seam (check, probe, motion validation), then writes `Out/<slug>.gif` (loops forever; the palette entry nearest the paper is pinned to the ground colour exactly, so the GIF sits on a slide or page of that colour with no visible box) and `Out/<slug>-poster.png` (the complete diagram). `<slug>` defaults to the project folder name.

Exit: 0 done, 1 refused or failed, 2 usage error.

## Spec

Coordinates are pixels in the frame (default 1920x1080; the frame must be at least 1.4:1).

```json
{
  "title": "How an Agent Harness Routes Work",
  "subtitle": "Intent goes in, verified output comes out",
  "hold": 3,
  "nodes": [
    { "id": "intent", "label": "Intent", "sub": "what done means", "x": 120, "y": 430, "w": 260, "h": 150, "shape": "pill", "step": 1 },
    { "id": "router", "label": "Router", "x": 560, "y": 420, "w": 280, "h": 170, "tone": "purple", "step": 2 }
  ],
  "edges": [
    { "from": "intent", "to": "router", "flow": true, "label": "requests", "bend": 0.1, "step": 2 }
  ],
  "insights": [
    { "text": "direction beats execution", "x": 470, "y": 640, "step": 2 }
  ]
}
```

| Field | Meaning |
|---|---|
| `title`, `subtitle` | Top-left, the title and subtitle faces. Required: `build` refuses a spec without both. An in-post figure is not a blog header and keeps its title block. |
| `untitled` | `"blog-header"` (the page carries the title) or `"deck"` (the slide does): the only two ways to omit `title` and `subtitle` |
| `nodes[].shape` | `box` (default), `pill`, `circle`, `cylinder` (stores, databases), `diamond` (decisions), `none` (a free-standing label such as DROP or ✕ TANGENT, still a valid edge end) |
| `nodes[].labelAlign` | `top` heads a container node so child nodes can sit inside it |
| `nodes[].tone` / `edges[].tone` | `ink` (default), `purple` (key components), `teal` (flows; default for `flow` edges) |
| `nodes[].sub` | Optional second line, sentence case |
| `nodes[].fontSize` | Override the label size (default from node height, 18–34 px) |
| `edges[].flow` | Dashes keep moving along the edge after it is drawn: a live path |
| `edges[].bend` | Bow as a fraction of length, sign picks the side (about ±0.1); the label sits on the outer side |
| `edges[].route` | `curve` (default), `hv` (horizontal then vertical), `vh` (vertical then horizontal) |
| `edges[].dashed` | A dashed edge (out of reach, optional, planned); never combined with `flow` |
| Backticks | In any label, `sub`, edge label or insight, a `` `span` `` renders as code: monospace, case kept (labels are otherwise uppercase). Use it for identifiers, SQL and literals |
| `insights[]` | 1–3 callouts, condensed italic, wrapped in asterisks for you; `tone` purple or teal; `maxWidth` to wrap |
| `step` | Integer build order. Each step draws its nodes, then its edges, then its insights. An edge cannot appear before both its nodes. |
| `hold` | Seconds the complete diagram holds before the loop fade (1.5–15, default 3) |
| `signature` | `false` to skip the DA-name signature (default on) |
| `width`, `height`, `fps` | Defaults 1920, 1080, 30 |
| `theme` | Palette overrides so the diagram sits on a page's own colors: `ground`, `ink`, `charcoal` (sub lines), `purple`, `teal`, `paper` (box fill), `purpleFill`, `tealFill`, `signature`, each `#rrggbb` or `rgb()`/`rgba()`; `ground` must be opaque (no alpha below 1). Default: `DiagramTheme.json` (§ Palette) over the shipped neutral palette |
| `subScale` | A node `sub` line as a share of its label size, 0.5–1 (default 0.62). Figures shown small on a page read better at about 0.75 |
| `strokeScale`, `typeScale` | Multiply stroke weight and type size (0.5–3). Deck slides read from the back of a room at about 1.8 and 1.5; full-width 21:9 panoramas want stroke about 2.6 |
| `ghost` | Opacity of the underdrawing, a faint copy of the finished diagram the ink draws over (0–0.4, default 0.13; 0 turns it off). It keeps the first frame, exports and the loop seam from ever being blank |

## Fonts

`<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/DiagramFonts.json` maps roles to font files:

```json
{ "title": { "path": "~/Library/Fonts/<serif italic>.otf", "style": "italic" }, "subtitle": { "path": "…" }, "label": { "path": "…", "weight": 700 }, "insight": { "path": "…", "weight": 700 }, "signature": { "path": "…" } }
```

A missing role uses a generic family. A configured file that is missing fails the build by name. A `.ttc` collection does not embed; extract the face first: `fonttools ttLib -y <index> <file.ttc> -o <face>.ttf`.

## Palette

`<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/DiagramTheme.json` sets the install palette, any subset of the `theme` keys above:

```json
{ "ground": "#F5F5F0", "purple": "#2B4C7E", "teal": "#3A7D44", "purpleFill": "rgba(43, 76, 126, 0.10)", "tealFill": "rgba(58, 125, 68, 0.10)" }
```

`build` layers it over the shipped neutral palette and under the spec's own `theme`, and writes the result into `diagram.json`, so `gif` pins the same ground. Without the file the shipped palette applies; an unknown key or a non-colour value fails the build, naming the file and key. `purple` and `teal` are the primary and secondary accent tones whatever colours you give them.
