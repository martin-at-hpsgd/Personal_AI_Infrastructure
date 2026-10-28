# Embossed Logo Wallpaper

> **Palette and setup.** The colours here are the skill's neutral defaults (amber, copper and ice white on a warm near-black). When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Wallpaper exists, its aesthetic, bright and muted palettes, mark description, terminal tint and apply command replace them everywhere below, prompts and checklist included. Without an apply command, report the saved path and set nothing.

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

Generates sophisticated wallpapers where the <brand> logo is integrated as an embossed texture within the visual content — not overlaid, not floating in empty space.

## Ideal State

- A 16:9 wallpaper at 4K+ (5504×3072 or similar) is saved at `$WALLPAPER_DIR/<output-name>.png` under a kebab-case name, in the style direction and tone (bright and energetic, or muted and subdued) the user asked for.
- The embossed mark has the shape of `<LOGO_FILE>` (passed as `--reference-image`), never the brand name as text, and its topology matches the reference stroke for stroke (SKILL.md Gotchas, 2026-06-11).
- The logo is embossed as texture with only a slight luminosity difference, in the same materials and colors as its surroundings; it is never overlaid, floating or glowing.
- The logo is small (3-5% of image width) and sits in the bottom left inside the visual content, surrounded by design elements rather than in an empty corner.
- Colors are only the wallpaper palette (PREFERENCES.md § Wallpaper, else the defaults below) on a deep black base, in its muted or bright set; no other hues.
- The style is sophisticated and dense with depth, never cartoony, flat or simple, and its quality matches the reference wallpapers.
- Visual content fills the entire canvas, with no blank areas.
- The wallpaper applied with the install's apply command passes every row of the Validation Checklist under Output format.

## Anti-criteria

- Never assume a location exists for the logo, the output directory or the reference wallpaper.
- If ANY validation check fails, the wallpaper is not delivered: regenerate with an adjusted prompt.
- Never literal text of the brand name instead of the logo shape, and never a logo that is overlaid, floating, glowing, too large or placed in an empty corner.

## Inputs

### Prerequisites

This intent takes **user-supplied** paths. Ask for them if they weren't given;
never assume a location exists.

**`<LOGO_FILE>`** — the logo to emboss. A flat, high-contrast PNG of the mark
itself (not a wordmark lockup) works best, since the intent reads its shape.

**`<WALLPAPER_DIR>`** — where the generated wallpaper is written.

**`<REFERENCE_WALLPAPER>`** *(optional)* — an existing image whose aesthetic to
match. If the user has none, skip the reference step and work from the style
description alone.

Set them once per shell so the commands below run as written:

```bash
export LOGO_FILE=/path/to/your/logo.png
export WALLPAPER_DIR=/path/to/your/wallpaper/output
```

Ask about:
1. **Style direction** — Photorealistic circuit, cyberpunk/hacker, abstract, etc.
2. **Tone** — Bright and energetic OR muted and subdued
3. **Output name** — Filename (kebab-case)

## Tool contract

```bash
# Verify the logo exists
ls "$LOGO_FILE"

# View the style reference, if the user supplied one
open "<REFERENCE_WALLPAPER>"
```

**Required prompt sections:**

```
1. AESTHETIC - Define the visual style (cyberpunk, circuit, etc.)

2. VISUAL COMPLEXITY - Specify density, layers, detail level

3. TONE - Muted/subdued OR bright (usually muted is better)

4. COLOR PALETTE (STRICT):
   - Deep black base (#0B0B0D)
   - Amber (#E0A040 or muted #A07A40)
   - Copper (#B86B3C or muted #7E5638)
   - Ice white (#D8E0E6 or muted #8A9096)
   - NO COLORS OUTSIDE THIS PALETTE

5. LOGO INTEGRATION (CRITICAL):
   - The logo shape from the reference image
   - EMBOSSED into surface (raised/pressed texture)
   - Position: bottom left WITHIN the visual content
   - Size: 3-5% of image width (SMALL)
   - Same materials/colors as surroundings
   - Slight luminosity difference only
   - NOT overlaid, NOT floating, NOT glowing
   - Must be surrounded by design elements

6. COMPOSITION:
   - Visual content fills ENTIRE canvas
   - NO empty corners or blank areas
   - Logo area has visual content WITH logo embossed into it

7. CRITICAL reminders:
   - Logo integrated INTO design
   - Logo SMALL and SUBTLE
   - Entire image has visual content
   - Correct color palette only
```

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=EmbossedLogoWallpaper \
  --model nano-banana-pro \
  --prompt "[CONSTRUCTED_PROMPT]" \
  --size 4K \
  --aspect-ratio 16:9 \
  --reference-image "$LOGO_FILE" \
  --output "$WALLPAPER_DIR"/<output-name>.png
```

Open the generated image and check every Validation Checklist row:

```bash
open -a "Google Chrome" "$WALLPAPER_DIR"/<output-name>.png
```

```bash
# Verify saved
ls -la "$WALLPAPER_DIR"/<output-name>.png

# Apply with the install's command (PREFERENCES.md § Wallpaper); without one, report the path
<apply command> <output-name>
```

**Color Palette (Muted):**
- Black: #0B0B0D
- Amber: #A07A40
- Copper: #7E5638
- Ice: #8A9096

**Color Palette (Bright):**
- Black: #0B0B0D
- Amber: #E0A040
- Copper: #B86B3C
- Ice: #D8E0E6

## Gotchas

Lessons learned, each failure with its correct treatment:

**1. Wrong Logo Treatment**
- ❌ Literal text of the brand name instead of the logo shape
- ❌ Logo overlaid/floating instead of embossed into surface
- ❌ Logo placed in empty/blank area instead of integrated into design
- ❌ Logo too large and prominent
- ❌ Logo glowing or different color than surroundings
- ✅ CORRECT: Logo shape from reference image, embossed as texture, small, within visual content

**2. Wrong Colors**
- ❌ Off-palette hues PREFERENCES.md § Wallpaper forbids by name
- ❌ Bright saturated neons
- ❌ Any colors outside the wallpaper palette
- ✅ CORRECT: Amber (#E0A040 or muted #A07A40), Copper (#B86B3C or muted #7E5638), Ice white (#D8E0E6 or muted #8A9096)

**3. Wrong Style**
- ❌ Simple, cartoony, flat vector art
- ❌ Too bright, loud, gaudy
- ❌ Clean lines without texture or depth
- ✅ CORRECT: Sophisticated, photorealistic or stylized with depth, muted/subdued, dense detail

**4. Wrong Composition**
- ❌ Logo in empty/blank corner
- ❌ Visual content clustered in center with empty edges
- ❌ Logo too prominent/centered
- ✅ CORRECT: Visual content fills entire canvas, logo small in bottom left WITHIN the design

**5. Missing Reference Images**
- ❌ Not using the supplied logo file as reference for logo shape
- ❌ Not checking existing wallpapers for quality benchmark
- ✅ CORRECT: Always use --reference-image with the logo file

Common fixes:
- Logo in wrong place → Emphasize "WITHIN the visual content" and "NO empty corners"
- Logo too big → Specify exact percentage "3-5% of image width"
- Wrong colors → List exact hex codes and explicitly name the off-palette hues to avoid
- Too bright → Add "MUTED, SUBDUED, desaturated"
- Too simple → Describe sophistication level, reference existing wallpapers

## Output format

**Validation Checklist:**

| Check | Pass/Fail |
|-------|-----------|
| Logo matches the shape in the reference image, not text | |
| Logo topology matches the reference (no stroke closed, dropped or added) | |
| Logo is EMBOSSED (texture), not overlaid or floating | |
| Logo is in bottom left corner | |
| Logo is SMALL (3-5% width) | |
| Logo is WITHIN visual content, not in empty space | |
| Logo is same color palette as surroundings | |
| Colors are ONLY the wallpaper palette (no off-palette hues) | |
| Style is sophisticated, not cartoony or simple | |
| Tone matches request (muted if requested) | |
| Visual content fills entire canvas (no blank areas) | |
| Quality matches reference wallpapers | |
| Image dimensions are 4K+ (5504×3072 or similar) | |

**If ANY check fails → regenerate with adjusted prompt**

## Examples

### Example Prompt (Muted Cyberpunk)

```
Cyberpunk hacker wallpaper, 16:9 4K resolution. SUBDUED AND MUTED.

AESTHETIC:
- Dense layers of data streams and neural network architecture
- Sophisticated cyberpunk atmosphere - [the taste references PREFERENCES.md § Wallpaper names, when set]
- Mature, serious, detailed styling

VISUAL COMPLEXITY:
- Thousands of tiny particles and data points
- Overlapping translucent layers of circuit geometry
- Dense but organized chaos throughout THE ENTIRE IMAGE
- Visual content should extend to ALL edges including bottom left
- NO empty or blank areas anywhere

TONE (SUBDUED AND HUMBLE):
- MUTED colors - desaturated, not neon bright
- DARK overall - near-black dominates
- Subtle glows instead of bright neon
- Quiet sophistication, not loud
- Moody and atmospheric

COLOR PALETTE (MUTED BRAND):
- Deep black void dominates (#0B0B0D)
- Muted amber (#A07A40) - muted
- Muted copper (#7E5638) - subtle
- Soft grey (#8A9096) - hints only

LOGO INTEGRATION (CRITICAL):
- The logo (from reference, described as PREFERENCES.md § Wallpaper or brand/README.md describes the mark) must be EMBOSSED INTO the visual content
- Position: bottom left, but WITHIN the circuit/data design, not in empty space
- The logo should be part of the circuit architecture - traces flow through it
- SMALL - about 3-5% of image width
- Same visual treatment as surrounding elements - muted, subtle
- Embossed texture - slight depth/luminosity difference only
- Should look like it was manufactured into the circuit board
- NOT floating in empty space - surrounded by and integrated with the design

COMPOSITION:
- Visual activity and detail must cover the ENTIRE canvas
- Bottom left corner has circuit detail WITH the logo embossed into it
- No blank corners or empty zones
- Uniform density of visual interest

CRITICAL:
- Logo MUST be integrated INTO the design, not placed in empty space
- Logo must be SMALL and SUBTLE
- Entire image should have visual content - no blank areas
- Subdued, muted, sophisticated
```
