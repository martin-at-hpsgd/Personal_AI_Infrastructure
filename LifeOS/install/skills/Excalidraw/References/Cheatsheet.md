# Excalidraw Cheatsheet

Adapted from the upstream `mcp-excalidraw-server` skill reference (yctimlin, MIT). All invocations here go through the pinned wrapper:

```bash
excal() { bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts "$@"; }   # shorthand used below
```

Canvas: `http://127.0.0.1:3579` (pinned in the wrapper; override with `EXCALIDRAW_PORT`). JSON on stdout except `describe` (plain text) and raw output when `--out` omitted. Diagnostics on stderr. Exit codes: 0 ok, 1 error, 2 usage, 3 canvas unreachable, 4 browser tab required. Canvas-touching commands auto-start the server.

## Commands

### Server

| Command | Description |
|---------|-------------|
| `excal start` | Start the canvas server (detached); prints URL + pid |
| `excal stop` | Stop it (identity-checked via `/health`) |
| `excal status` | Health, element count, connected browser tabs |

### Elements

| Command | Description |
|---------|-------------|
| `excal add [file\|-]` | Batch create from JSON array (file or stdin); `--one '{...}'` for one |
| `excal apply [file\|-]` | Multi-op patch `{"create":[...],"update":[{"id":"a","set":{...}}],"delete":["id"]}` |
| `excal get <id>` | Get one element |
| `excal query` | `--type rectangle` `--bbox x0,y0,x1,y1` `--filter label.text=API` `--filter-json '{...}'` |
| `excal update <id> --set '{...}'` | Update one element |
| `excal delete <id> [...]` | Delete elements |

### Scene

| Command | Description |
|---------|-------------|
| `excal describe` | AI-readable scene summary: ids, positions, labels, connections |
| `excal screenshot [--out f.png] [--format png\|svg] [--no-background]` | Capture (**browser tab required**) |
| `excal export [--out f.excalidraw] [--format json\|obsidian]` | Scene file; `.md` out path → Obsidian format |
| `excal import [file\|-] [--replace]` | Import `.excalidraw` or Obsidian `.excalidraw.md` (merge default) |
| `excal mermaid [file\|-]` | Render Mermaid onto the canvas (**browser tab required**) |
| `excal share` | Encrypted upload → shareable excalidraw.com URL |
| `excal clear --yes` | Wipe the canvas |
| `excal snapshot save\|list\|restore [name]` | Named canvas snapshots |

### Arrange

| Command | Description |
|---------|-------------|
| `excal arrange align --ids a,b,c --to left\|center\|right\|top\|middle\|bottom` | Align (≥2) |
| `excal arrange distribute --ids a,b,c --to horizontal\|vertical` | Even spacing (≥3) |
| `excal arrange group --ids a,b` / `ungroup --group <id>` | Grouping |
| `excal arrange lock\|unlock --ids a,b` | Edit lock |
| `excal arrange duplicate --ids a,b [--offset 20,20]` | Clone with offset |

## Element format (agent-friendly, auto-normalized)

- **Labels**: `"text": "My Label"` on any shape → converted to bound-label format.
- **Arrow binding**: `"startElementId": "a"` / `"endElementId": "b"` — arrows auto-route to edges and re-route when endpoints move.
- **Custom ids**: set `"id": "auth-svc"` at create time; later updates address by id.
- **`fontFamily`**: string only — `"1"`–`"8"` or a name (`"helvetica"`, `"cascadia"`, `"excalifont"`).
- **`points`**: `[[x,y],...]` tuples or `[{"x":..,"y":..}]` objects both accepted.
- **Curved arrows**: 3+ points with `"roundness": {"type": 2}`. **Elbowed**: `"elbowed": true` with right-angle waypoints.
- **`apply` update entries**: direct fields (`{"id":"a","x":120}`) or `set` object — never both in one entry.

## Design guide

- **Palette (stroke/fill pairs)**: `#e03131`/`#ffc9c9` red · `#2f9e44`/`#b2f2bb` green · `#1971c2`/`#a5d8ff` blue · `#9c36b5`/`#eebefa` purple · `#e8590c`/`#ffd8a8` orange · `#0c8599`/`#99e9f2` cyan · `#868e96`/`#e9ecef` gray.
- `"fillStyle": "solid"` for crisp flat fills (default is sketchy hachure); `"strokeStyle": "dashed"` for zone borders and async arrows.
- Sizing: shapes ≥120×60, width ≥ `labelChars * 12`; fonts ≥16 (titles ≥20); gaps 40–80px (120px+ for labeled arrows); 20px grid.
- Coordinates: (0,0) origin, x right, y down. Tiers 80–120px apart vertically. Zone padding 50px.
- Order of work: background zones → primary shapes → arrows → annotations → refine.

## Layout anti-patterns

1. **No `text` on background-zone rectangles** — the bound label centers mid-zone over everything inside. Zone labels are free-standing text elements at the zone's top-left.
2. **No cross-zone arrows through other zones** — keep arrows within a tier, or route elbowed arrows along the perimeter.
3. **Arrow labels sparingly** — midpoint placement collides on short/crowded arrows; ≤12 chars, essential relationships only.

## Quality checklist (after every batch, before declaring done)

Check with `excal describe` after each batch, and judge the visuals on the excalidraw.com render from `Tools/Share.ts`, never a local `screenshot` (the local canvas mis-renders API-created text; SKILL.md Gotchas): text fully visible · no shape overlap · no arrows through unrelated elements · arrow labels clear of shapes · ≥40px gaps · fonts ≥16 · zone labels free-standing. Any failure: stop, fix, re-check, then continue.

## Error recovery

- **Exit 3**: server unreachable — run `excal start`, or check `EXCALIDRAW_PORT`/`EXPRESS_SERVER_URL`.
- **Exit 4**: open the canvas URL in a browser tab, retry (screenshot/mermaid/image-export/viewport render in the frontend).
- **Elements off-screen**: browser zoom-to-fit, or check `describe` bounding boxes.
- **Arrow not connecting**: verify ids with `excal get <id>`.
- **Bad state**: `excal snapshot save` → `excal clear --yes` → rebuild, or `snapshot restore`.
- **Duplicate bound-text elements**: `excal query --type text`, delete entries with `containerId` pointing at zone rects.

## REST API (last resort — server must already run)

`http://127.0.0.1:3579` — `GET/POST /api/elements`, `POST /api/elements/batch`, `GET /api/elements/search`, `DELETE /api/elements/:id`, `POST /api/elements/from-mermaid`, `POST /api/snapshots`, `GET /health`. Raw REST is stricter: labels are `"label": {"text": "..."}`, bindings `"start"/"end": {"id": "..."}`.
