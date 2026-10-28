# Blog headers: command, transparency and wiring

Moved out of `SKILL.md` § Tool contract. Read it on any run that makes, cuts or wires a blog header (the Essay intent, or any `--thumbnail` run), before the files move into a site. The Essay intent carries its own optimize recipe; this file holds the facts it shares with the blog-authoring skill.

## Blog-header command

A blog header adds `--thumbnail` to the default command:

```bash
bun run ${LIFEOS_SKILL_DIR}/Tools/Generate.ts \
  --intent=Essay \
  --slug <blog-post-slug> \
  --model nano-banana-pro \
  --prompt "[PROMPT]" \
  --size 2K \
  --aspect-ratio 16:9 \
  --thumbnail \
  --output "$ART_DIR"/blog-header-concept.png

# Once the image may move (SKILL.md § Output staging), copy to the final location (substitute your blog/site path)
cp "$ART_DIR"/blog-header-concept.png ~/your-site/public/images/
cp "$ART_DIR"/blog-header-concept-thumb.png ~/your-site/public/images/
```

Essay's contract refuses the run unless `scratchpad/art/<slug>/cse.md` and `composition.md` already exist (Essay.md Tool contract § Machine-verified preflight).

`--thumbnail` writes TWO versions:
1. `output.png` — Transparent background (for compositing over website backgrounds)
2. `output-thumb.png` — On the page ground, `thumbnailGround` in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/ArtConfig.json` (shipped default `#F5F5F0`) (full-size source for the listing thumbnail; not the social card or OpenGraph image)

## Blog-header transparency

This section is the canonical home for blog-header transparency; the blog-authoring skill defers here. "Page ground" below is the blog page background colour, set once as `thumbnailGround` in `ArtConfig.json` and in `PREFERENCES.md` § Color palette.

- Inline (body) image: transparent PNG with alpha, because the blog page has its own ground colour and the image must composite cleanly over it.
- Listing thumbnail (frontmatter): opaque, flattened on the page ground, because the blog listing and RSS readers do not honor transparency and show white/black bleed-through.
- Every blog header uses `--thumbnail`, which produces both.

`--thumbnail` is the only correct flag for blog headers. It implicitly enables `--remove-bg` and produces both `output.png` (transparent) and `output-thumb.png` (page-ground background). Background removal runs locally via `rembg` (no external API). Nano Banana Pro often returns JPEG; `Generate.ts` renames the output from `.jpg` → `.png` after rembg processing so the final transparent file is a real PNG with a real alpha channel. A `.jpg` labeled "transparent" is not transparent. If `rembg` isn't installed at `~/.local/bin/rembg`, the tool fails loudly with install instructions rather than silently producing an opaque image. Install: `pipx install rembg` (or set `REMBG_BIN` env var to override the path).

The thumbnail is the listing image, not the social card: X and LinkedIn read the post's OpenGraph image, which many blogs build (1200x630) from the largest image the post has, so keep the full-size header. Where the principal's site builds its social card is that site's business (its `PROJECTS.md` row or repo), not this skill's.

Verification before an image is called done:

1. `file "$ART_DIR"/[name].png` reports `PNG image data, ... RGBA` (8-bit/color RGBA). `JPEG` or `8-bit colormap` without alpha means transparency failed.
2. `file "$ART_DIR"/[name]-thumb.png` reports `PNG image data`. The thumb is intentionally opaque on the page ground.
3. Only after both pass: copy to the project directory and wire into the post.

Wiring into the blog post:

- Body inline: `[![Alt](/images/blog/[slug]/header.webp)](/images/blog/[slug]/header.webp)`, the transparent WebP converted from the `.png`.
- Frontmatter: `thumbnail: https://example.com/images/blog/[slug]/header-thumb.png`, always the opaque page-ground thumbnail (the Essay intent's optimize step writes it as `-thumb-optimized.png` from `-thumb.png`).

Never reuse the opaque thumbnail for the inline slot, and never reuse the transparent file for the listing thumbnail; they are two distinct outputs from one `--thumbnail` run.

Sanctioned exception: transparent inline is the default for every blog header. The one exception is thin-linework/charcoal pieces where rembg strips the artwork itself (SKILL.md § Gotchas, on `--remove-bg` and thin linework). Those may ship an opaque inline image drawn on the page ground, which composites seamlessly on the matching page background. Opaque inline is a documented fallback for that failure mode, never a second default.

## Background removal outside a blog header

For non-blog images that only need transparency, or to remove backgrounds after generation:

```bash
# Background removal — Art skill tool (Images was retired into Art)
# ported from public PR #1707 (commit 1), @anikinsasha
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts /path/to/output.png

# Or batch process multiple images (each cut in place; needs --batch)
bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts --batch image1.png image2.png image3.png
```

## Gotchas

- **White-box-on-cream bug (2026-06-20): flattening an opaque jpeg on the page ground is a no-op.** nano-banana-pro returns an opaque JPEG; `magick -background "<ground>" -flatten` only fills *alpha*, so the model's baked near-white ground survives and paints a white rectangle on a tinted blog page. For inline blog headers, cut true alpha first (`bun ~/.claude/LIFEOS/TOOLS/RemoveBg.ts`), then derive the WebP, and verify `identify -format "%[channels]" inline.webp` == `srgba`. Opaque page-ground inline is valid only on an image that already has alpha. See Essay.md Step 7.0.5.
- **Interior-white ban (2026-07-09, "giant white space" incident):** prompt large flat surfaces (desks, panels, windows, paper) in the page ground's tone ("warm cream paper tone" on a cream page), never bright white or unstated — baked-white interiors survive rembg intact and render as giant white rectangles on a tinted page. Inside-the-subject sibling of the 2026-06-20 white-box bug. Also trim white padding off any external screenshot before embedding (`magick -fuzz 4% -trim` + a page-ground border).
