---
provenance: template
version: 1.0.0
---

# Excalidraw preferences

> The Excalidraw skill checks `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Excalidraw/` and applies
> any `PREFERENCES.md` it finds over its defaults. No tool parses this file; the skill reads
> it as prose when sketching (`Intents/SketchDiagram.md`). Every section is optional. The
> values below are the shipped defaults, so leaving them alone changes nothing.

## Canvas ground

Background color for diagrams and for `Tools/Share.ts --bg`.

- Ground: `#0d0d0f` (black). The skill guarantees it two ways: an oversized backdrop rectangle in the scene and the file's `viewBackgroundColor`.

## Palette

Stroke/fill pairs for shapes. Labels take the shape's stroke color, so keep strokes readable on their fills (pale fill, saturated stroke).

- Red `#e03131` / `#ffc9c9`
- Green `#2f9e44` / `#b2f2bb`
- Blue `#1971c2` / `#a5d8ff`
- Purple `#9c36b5` / `#eebefa`
- Orange `#e8590c` / `#ffd8a8`
- Cyan `#0c8599` / `#99e9f2`
- Gray `#868e96` / `#e9ecef`

## Export directory

Where exported `.excalidraw` files and screenshots land when you do not name a path.

- Export directory: `~/Downloads`

## Canvas port

The local canvas server port. The tools read this from the environment, not from this file: set `EXCALIDRAW_PORT` (default `3579`) or `EXPRESS_SERVER_URL` (default `http://127.0.0.1:3579`) in your shell. Record your choice here so the skill uses the matching URL when it opens the canvas.

- Port: `3579`
