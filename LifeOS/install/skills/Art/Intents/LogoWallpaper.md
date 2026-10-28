# LogoWallpaper

> **Palette and setup.** The colours here are the skill's neutral defaults (amber, copper and ice white on a warm near-black). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Wallpaper exists, its aesthetic, bright and muted palettes, mark description, terminal tint and apply command replace them everywhere below, prompts and checklist included. Without an apply command, report the saved path and set nothing.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples

A 4K 16:9 branded wallpaper for a terminal background and the desktop, with a <brand> logo integrated as an organic design element (emblazoned, embossed, woven or negative space).

## Ideal State

- A 16:9 wallpaper at 4K exists in `$WALLPAPER_DIR` under the user's kebab-case output name, generated with nano-banana-pro with the selected logo from `$LOGO_DIR` passed as `--reference-image`.
- The generation prompt describes the selected logo file's primary shapes and forms, key geometric elements, and aspect ratio and proportions, as read from the file itself before the prompt was written.
- The logo shape is recognizable but integrated, an integral design element (emblazoned, embossed, woven or negative space) rather than pasted on or overlaid; with no specific direction it is woven, matches the closest existing wallpaper style, and uses the primary <brand> logo if available.
- The logo's topology matches the reference stroke for stroke: no open mark closed into a loop, no isolated element dropped, no stroke added. Perspective and 3D scenes break this most often (SKILL.md Gotchas, 2026-06-11).
- It matches the install's wallpaper aesthetic and palette (PREFERENCES.md § Wallpaper; default: the style direction given, in the neutral palette below on a dark background); when the user supplied a reference wallpaper it was viewed and matched, otherwise the style description was the guide.
- It works as both a terminal background (under the terminal tint PREFERENCES.md § Wallpaper names) and a desktop background: the pattern has enough contrast to show through that tint, and the image is of professional quality with no artifacts, text or watermarks.
- Once it passes every Validation checklist row, it is applied with the install's apply command (PREFERENCES.md § Wallpaper); without one, the saved path is reported and nothing is set.

## Anti-criteria

- Never assumes a location exists: user-supplied paths that weren't given are asked for (the reference wallpaper is optional and skipped when the user has none).
- Never a logo pasted on or overlaid on the pattern, and never text or watermarks in the wallpaper.

## Inputs

### Prerequisites

This intent takes **user-supplied** paths. Ask for them if they weren't given;
never assume a location exists.

**`<LOGO_DIR>`** — the directory holding the user's logo files (PNG, SVG). Used as
reference for shape/concept integration.

**`<WALLPAPER_DIR>`** — where generated wallpapers are written.

**`<REFERENCE_WALLPAPER>`** *(optional)* — an existing image whose aesthetic the
new wallpaper should match. If the user has no reference image, skip the
reference-loading step and work from the style description alone.

Set them once per shell so the commands below run as written:

```bash
export LOGO_DIR=/path/to/your/logos
export WALLPAPER_DIR=/path/to/your/wallpaper/output
```

**Required from user:**
1. **Logo selection** — Which logo from `$LOGO_DIR` to embed
2. **Style direction** — Circuit, geometric, abstract, flowing, etc.
3. **Integration style** — How logo appears:
   - **Emblazoned** — Logo shape as glowing focal point
   - **Embossed** — Logo as subtle raised/pressed texture
   - **Woven** — Logo dissolved into pattern (circuits flow through it)
   - **Negative space** — Logo revealed by absence of pattern
4. **Output name** — Filename for the wallpaper (kebab-case, no extension)

With no specific direction, the Ideal State defaults apply (woven, closest existing style, primary logo).

## Tool contract

```bash
# List available logos
ls "$LOGO_DIR"

# View selected logo
open "$LOGO_DIR/<logo-name>.png"
```

If the user supplied a reference image, view it to match the aesthetic:

```bash
open "<REFERENCE_WALLPAPER>"
```

No reference image? Skip this step and work from the style description.

**Base prompt template:**

```
Dark tech wallpaper for terminal/desktop, 16:9 4K resolution.

BACKGROUND: Deep dark warm-black gradient (#0B0B0D to #1B1C20)

INTEGRATION: [LOGO_NAME] logo shape [INTEGRATION_STYLE]:
- [Describe how logo integrates with the pattern]
- [Logo should feel organic to the design, not overlaid]
- [Shape emerges from or defines the pattern flow]

PATTERN STYLE: [STYLE_DIRECTION]
- [Specific pattern elements matching style]
- [How pattern interacts with logo shape]

COLOR PALETTE:
- Primary: Signal amber (#E0A040) — main circuit lines/elements
- Secondary: Copper (#B86B3C) — accent glows, key nodes
- Tertiary: Ice white (#D8E0E6) — highlights, energy points
- Background: Near-black with subtle warm undertone

EFFECTS:
- Subtle depth of field (sharper center, soft edges)
- Glow effects on key nodes and accent points
- Fine detail in circuit traces/patterns
- Atmospheric haze in corners

CRITICAL:
- Logo shape is INTEGRAL to design, not overlaid
- Must work as terminal background under the terminal tint (PREFERENCES.md § Wallpaper; e.g. a dark overlay)
- No text, no watermarks
- High contrast details for visibility through tint
- Professional, sophisticated tech aesthetic
```

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=LogoWallpaper \
  --model nano-banana-pro \
  --prompt "[CONSTRUCTED_PROMPT]" \
  --size 4K \
  --aspect-ratio 16:9 \
  --reference-image "$LOGO_DIR"/<selected-logo>.png \
  --output "$WALLPAPER_DIR"/<output-name>.png
```

**Parameters:**
- `--size 4K` — Maximum resolution
- `--aspect-ratio 16:9` — Standard widescreen
- `--reference-image` — Logo file for shape guidance

**Open the generated wallpaper:**
```bash
open "$WALLPAPER_DIR"/<output-name>.png
```

If a checklist row fails, refine the prompt (logo integration wording, or a different integration style) and regenerate. Once validated, apply:

```bash
<apply command from PREFERENCES.md § Wallpaper> <output-name>
```

Without an apply command, report the saved path instead.

## Output format

Palette: background #0B0B0D to #1B1C20, Amber #E0A040, Copper #B86B3C, Ice white #D8E0E6. Integration styles: Emblazoned, Embossed, Woven, Negative Space. Pattern styles: Circuit, Geometric, Flowing, Abstract.

**Validation checklist:**
- [ ] Logo shape is recognizable but integrated (not pasted on)
- [ ] Logo topology matches the reference (no stroke closed, dropped or added)
- [ ] Color palette matches the wallpaper palette (PREFERENCES.md § Wallpaper, else the defaults here) on dark
- [ ] Pattern has enough contrast to show through the terminal tint
- [ ] No artifacts, text, or watermarks
- [ ] Professional quality suitable for desktop/terminal

### Integration Styles Reference

### Emblazoned
Logo as the **glowing focal point** — circuits/patterns radiate outward from it.
```
Logo shape as central glowing element, circuit traces emanating outward from its edges,
energy nodes at key logo vertices, pattern density increases near logo
```

### Embossed
Logo as **subtle texture** — raised or pressed into the pattern layer.
```
Logo shape visible as subtle raised/depressed region in the pattern,
same color palette but slightly different luminosity, discoverable not obvious
```

### Woven
Logo shape **defines pattern flow** — elements flow through/around it.
```
Circuit traces and geometric elements flow through and around logo shape,
logo boundary influences pattern direction, shape emerges from negative space
```

### Negative Space
Logo **revealed by absence** — pattern stops at logo boundaries.
```
Dense pattern everywhere except logo shape, logo appears as void/window,
subtle glow at logo edges where pattern meets empty space
```

### Style Directions Reference

### Circuit
Dense circuit board traces, nodes, and connection points.
```
PCB-style traces with right-angle turns, solder points as nodes,
varying trace widths, layer depth with traces at different z-levels
```

### Geometric
Abstract geometric shapes, grids, and mathematical patterns.
```
Interlocking geometric shapes, hexagonal grids, triangular tessellation,
isometric depth, clean edges with subtle glow
```

### Flowing
Organic flowing lines, data streams, particle flows.
```
Smooth curved lines suggesting data flow, particle streams,
gradient intensity along flow direction, organic movement feel
```

### Abstract
Non-representational artistic interpretation.
```
Abstract color fields, gradient washes, subtle texture,
artistic interpretation of tech aesthetic, minimal but sophisticated
```

## Examples

### Example 1: <brand> logo Woven into Circuits
```
Dark tech wallpaper for terminal/desktop, 16:9 4K resolution.

BACKGROUND: Deep dark warm-black gradient (#0B0B0D to #1B1C20)

INTEGRATION: <brand> logo shape woven into circuit pattern:
- Circuit traces flow through and around the logo silhouette
- Logo boundary subtly influences trace direction
- Shape emerges naturally from the pattern density changes
- Not overlaid — the pattern DEFINES the logo through flow

PATTERN STYLE: Dense circuit board
- Fine PCB-style traces with right-angle routing
- Glowing nodes at trace intersections
- Multiple depth layers (foreground sharp, background soft)
- Trace density varies to create visual interest

COLOR PALETTE:
- Primary: Signal amber (#E0A040) — main traces
- Secondary: Copper (#B86B3C) — key nodes, logo edge glow
- Tertiary: Ice white (#D8E0E6) — energy highlights
- Background: Near-black (#0B0B0D)

EFFECTS:
- Depth of field blur at edges
- Subtle copper glow where logo shape meets pattern
- Fine detail in traces (visible at 4K)
- Atmospheric corner vignette

CRITICAL: Logo integrated into design, not overlaid. Must show through the terminal tint.
```

### Example 2: Logo Emblazoned in Geometric Field
```
Dark tech wallpaper for terminal/desktop, 16:9 4K resolution.

BACKGROUND: Deep space gradient (#0B0B0D to #1B1C20)

INTEGRATION: <brand> logo as central emblazoned element:
- Logo shape glows at center with copper (#B86B3C) core
- Geometric patterns radiate outward from logo edges
- Energy lines connect logo vertices to outer pattern
- Logo is the source/origin of all pattern elements

PATTERN STYLE: Geometric hexagonal grid
- Hexagonal tessellation extending from logo
- Grid density increases toward edges
- Subtle isometric depth
- Clean geometric precision

COLOR PALETTE:
- Primary: Signal amber (#E0A040) — grid lines
- Secondary: Copper (#B86B3C) — logo glow, accent nodes
- Tertiary: Ice white (#D8E0E6) — energy connections
- Background: Near-black with warm undertone

EFFECTS:
- Central glow around logo
- Sharp center, soft edges
- Subtle particle effects
- Corner vignette

CRITICAL: Logo as design origin point, not pasted overlay. High contrast for tint visibility.
```
