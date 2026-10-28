# SystemFilm.ts

Turns a system-run script (JSON) into a HyperFrames composition that shows the system running as a live dashboard, in the house theme from `Theme.ts`.

```bash
bun skills/HyperFrames/Tools/SystemFilm.ts --script <script.json> --dir <project> [--force]
```

Writes `<project>/index.html` (one paused GSAP timeline, registered as `main`) and `<project>/STORYBOARD.md` (every phase, value change, log line and the outcome in time order, for `Proof.ts plan`), and stages GSAP into `<project>/vendor/`. Exit 0 written, 1 invalid script or an existing `index.html` without `--force`, 2 usage.

## Script schema

| Field | Type | Meaning |
|---|---|---|
| `title` | string | The header title; also seeds the field, so a script renders the same every time. |
| `kicker` | string? | Centre header label, e.g. `LIFEOS / WORKFLOWS`. |
| `source` | string | Required. Where every value came from; printed in the footer. |
| `sources` | `{id: path}`? | Source files, paths relative to the script. Declared, every log line and outcome line must carry `from` and be a verbatim quote (case and spacing aside) of that source line, or the build refuses it. |
| `illustrative` | bool? | `true` prints "illustrative data" in the footer. |
| `size` | `{width,height,fps}`? | Default 1080×1350 at 30 fps. Even sizes only. |
| `duration` | number | 8–40 s. |
| `stats` | `[label, value][]`? | Small header stats. |
| `phases` | `{label, at}[]` | The system's own stages, at least two, in time order. The header shows the current one. |
| `cards` | `{id, title, rows, at?}[]` | 2–16 parts. `rows` are 1–6 `[key, value, tone?]`. `at` overrides the entry time. |
| `edges` | `[fromId, toId][]`? | Real connections. Drawn port to port, with signals travelling along them. |
| `events` | `{at, focus?, set?, log?}[]` | `focus: cardId` lights one card and dims the rest. `set: {card, key, value, tone?}` changes a row value. `log: {tag, text, tone?, time?, from?}` adds a run-log line; `time` is the real clock time to show, and `from` is `"<source id>:<line>"`, the line it quotes. |
| `bars` | `{label, steps: [t, fraction][], status?: [t, text, tone?][]}[]`? | Up to 5 dispatch bars. A status tone colours the bar and its label, so fail, pass and open read apart. |
| `counter` | `{label, steps: [t, value][], sub?, items?: [t, text][]}`? | The big number. It ticks only in the last 0.8 s before each step. `items` lists what the count is made of under the number, newest last, and the list hides when the outcome lands. |
| `outcome` | `{at, title, lines, tone?, from?}`? | The point the film lands on; it must hold at least 2 s. `from[i]` is the source line `lines[i]` quotes. |
| `footer` | string? | The flow band between the grid and the panels, e.g. `sync -> triage -> remediate`. |
| `look` | `"dashboard" \| "terminal"`? | `dashboard` (default): glowing cards over a drifting dot grid. `terminal`: the frame is a terminal window with flat, role-coloured boxes, dotted edges that march toward their target, and an optional legend and prompt line. The fields below draw only in the terminal look and are refused without it. |
| `camera` | `"follow" \| "still"`? | `follow` (default): the whole frame at the start and at each phase change, a close shot on the part each event changes (its card, the log, the output), one part per shot, at least 1.6 s close and 1.2 s wide, pushing in at 6% a second. `still`: the whole frame throughout, for proving the layout with TextFit. |
| `window` | string? | Terminal: the window title bar text. Default `~ — zsh`. |
| `roles` | `{id, label, tone}[]`? | Terminal: 1–5 roles, drawn as a legend under the header. |
| `cards[].role` | string? | Terminal: the role whose colour the card's border and title take; the focused card shows it at full strength. |
| `prompt` | `{command, cwd?, status?: [t, text, tone?][]}`? | Terminal: `<cwd> $ <command>` typed in over the first 1.4 s with a blinking block cursor, and a status line under it that changes at each `status` time. |

Tones: `good`, `bad`, `warn`, `accent`, `info`, `muted`, `text`. They map to theme colours; a script never carries a hex value. A terminal film in the reference palette uses `warn` (amber), `info` (blue), `good` (green) and `accent` (the house accent) for its roles.

## What the tool guarantees

- Every word is set in the code role's face from the seam's `roleFaces("code")` (the house TypeRoles.json face and its case, or the compiler's bundled JetBrains Mono), embedded, named first, and loaded before the timeline registers.
- Text sits inside TextFit's 5% title-safe frame, and fonts are sized to the longest line, so nothing ellipsizes.
- The column count is chosen so the grid fills the card area. A short last row is centred, and a row enters together.
- Panels are as tall as their content. A full log drops its oldest line instead of sliding lines under the panel edge.
- Edges that share a card side get their own ports, spread in the order they head. A changed value flashes a ring in its own colour.
- Only real `edges` are drawn, port to port, and an edge that would pass behind a third card is routed through the gutter. Cards are opaque, so no line crosses text. Texture comes from a drifting dot grid.
- Changing text is a stack of real spans shown by `tl.set`, so any seek, Proof's included, reads the right value. Signals use a seeded PRNG and start once their edge is drawn.
