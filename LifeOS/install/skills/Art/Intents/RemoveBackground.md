# RemoveBackground

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Examples · References

Removes the background from an existing image with local rembg (no external API), leaving a transparent PNG.

## Ideal State

- The output is real PNG with an alpha channel: `file` reports "PNG image data, ... RGBA" and `magick identify -format "%[channels]"` reports a channel string that contains "a" (such as "srgba"). A `.jpg` input ends as a `.png`, because rembg always emits PNG.
- Every subject in the image survives the cut with a clean edge, confirmed by looking at the cut PNG: in a multi-subject composition no secondary subject, person, thin prop or signature is faded or erased.
- The original survives: either the cut went to an explicit output path, or the source was copied before an in-place run. Removed alpha zeroes the RGB beneath it, so a cut cannot be flattened back into its source.
- The cut stays in a staging location for review, never written straight into a project's `public/images/`; it replaces the original or is copied to its project destination only after its transparency and every subject were verified.
- The background was removed locally with `rembg`, through the LifeOS `RemoveBg.ts` wrapper or `rembg i` directly: no external API, no rate limits, no API keys.

## Anti-criteria

- Never treat an output whose channels read "srgb" without "a" as done: that means NO alpha, and the transparency failed.
- Never send the image to an external background-removal API; the intent switched from poof.bg to local rembg on 2026-04-27.
- Never run an in-place cut on a one-of-a-kind image without a copy of the original.
- A multi-subject image cut with the default `u2net` model and shipped without checking that every subject survived.

## Inputs

An existing image file (PNG, JPG or WebP), or several for a batch, and optionally an explicit output path. Typical uses: diagrams that sit on a page with its own ground colour, icons, cleaned-up screenshots.

## Safety gates

- The single-file and batch in-place modes of `RemoveBg.ts` overwrite each input immediately and unrecoverably. Copy the original first, or pass an explicit output path.
- Two arguments always mean input and output, and re-running one replaces the output from the untouched input. Batch in place needs the explicit `--batch` flag; three or more paths without it are refused (`LIFEOS/TOOLS/RemoveBg.ts` 1.6.0, 2026-10-13, which retired the old form that batch-cut both files whenever the second path already existed).

## Tool contract

### Tooling

Local `rembg` (Python, ONNX-based, runs offline).

**Default binary path:** `~/.local/bin/rembg` (override with `REMBG_BIN` env var).

**Install if missing:**
```bash
pipx install rembg          # preferred
# or
uv tool install rembg       # if you use uv
```

### Remove the background

The LifeOS `RemoveBg.ts` wrapper calls local `rembg` with its default model and handles the `.jpg → .png` rename automatically (rembg always emits PNG):

```bash
# Single file (overwrites; renames .jpg→.png)
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts input-image.png

# Single file with explicit output path
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts input-image.jpg output-image.png

# Batch (overwrites each in place; needs --batch)
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts --batch img1.png img2.png img3.png
```

`RemoveBg.ts` takes no model flag. To choose a model, call `rembg` directly; use `birefnet-general` for any image with more than one subject:

```bash
~/.local/bin/rembg i input-image.png output-image.png
~/.local/bin/rembg i -m birefnet-general input.png output.png    # higher quality, slower; keeps every subject
```

### Verify transparency

```bash
# MUST report "PNG image data, ... RGBA"
file output-image.png

# Sanity-check alpha via ImageMagick
magick identify -format "%[channels]" output-image.png
# → "srgba" (or contains "a") = alpha present
# → "srgb" without "a" = NO alpha — transparency failed
```

Then Read the PNG and check every subject is still there.

### Replace or copy to destination

```bash
# Replace original (after verification)
mv output-image.png input-image.png

# Or copy to specific destination
cp output-image.png /destination/path/transparent-image.png
```

## Gotchas

**Problem:** `rembg not found at ~/.local/bin/rembg`
**Solution:** `pipx install rembg` (or set `REMBG_BIN` env var to your installed path).

**Problem:** First run is slow (downloads ONNX model)
**Solution:** Expected. The default `u2net` model (~176MB) is fetched once into `~/.u2net/`, then cached forever. Subsequent runs are fast.

**Problem:** Output file looks identical to input
**Solution:** rembg failed to detect a clear subject. Try a model better suited to the content:
```bash
~/.local/bin/rembg i -m u2netp input.png output.png       # smaller/faster
~/.local/bin/rembg i -m isnet-general-use input.png output.png   # general-purpose, often better edges
~/.local/bin/rembg i -m birefnet-general input.png output.png    # higher quality, slower
```

**Problem:** Edges are jagged or hair/fine detail is lost
**Solution:** Use `birefnet-general` (or `birefnet-portrait` for people) — both produce noticeably better edges than the default `u2net`.

Two cut failures recorded in SKILL.md § Gotchas apply here: the default model erasing secondary subjects in a multi-subject image (2026-09-23, a two-subject header; cut with `-m birefnet-general` from a kept copy), and thin black linework stripped as background (2026-05-11, a flowchart; when the destination background matches the image's own, skip the cut).

## Examples

All three work in a staging directory outside Downloads (SKILL.md § Output staging) with an explicit output path, so every original survives; a cut reaches Downloads only through `Deliver.ts`.

### Example 1: Remove background from a diagram, keeping the original

```bash
ART_DIR=scratchpad/art/example-diagram
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts "$ART_DIR"/ExampleDiagram.png "$ART_DIR"/ExampleDiagram-cut.png
file "$ART_DIR"/ExampleDiagram-cut.png    # expect RGBA, then Read it
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact "$ART_DIR"/ExampleDiagram-cut.png --to ~/Downloads
```

### Example 2: Remove background and save with new name

```bash
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts \
  "$ART_DIR"/logo-with-bg.png \
  "$ART_DIR"/logo-transparent.png
```

### Example 3: Process multiple images

```bash
mkdir -p "$ART_DIR"/cut
for f in "$ART_DIR"/diagram-*.png; do
  out="$ART_DIR/cut/$(basename "$f")"
  [ -e "$out" ] || bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts "$f" "$out"
done
```

## References

- `Intents/SalesVisual.md` — uses the `--remove-bg` flag in Generate.ts (backed by local rembg)
- `Intents/Essay.md` — `--thumbnail` flag in Generate.ts implicitly removes background via local rembg
