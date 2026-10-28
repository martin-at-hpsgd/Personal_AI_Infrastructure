# Keynote — READ.md to a Keynote deck whose notes are the talk

**Single purpose.** Build a `.key` file from a lecture's READ.md. Presenter notes come from READ.md only. An Opus-tier model (via `LIFEOS/TOOLS/Inference.ts`, anthropic lane) designs each section's slides and how its sentences split across them. Every slide is one of two types: **full** (one image fills the slide, title and subtitle top-left as real text) or **split** (title and subtitle top-left, 1–4 bullets left, image right). A slide uses an existing image or carries an art brief; until that art exists the builder draws a marked placeholder showing the brief. Keynote is driven through `osascript` (JXA).

## Usage

```bash
bun Keynote.ts --read <READ.md> [--out deck.key] [--design KEYNOTE.json]
               [--style style.json] [--theme "Basic White"] [--images <dir>]
               [--title "…"] [--subtitle "…"] [--concurrency 4]
               [--section N[,N…]] [--direction "…"] [--redesign-all]
               [--design-only] [--export <png-dir>] [--real <RealThings.json>]
bun Keynote.ts --read <READ.md> --verify <deck.key>
bun Keynote.ts --read <READ.md> --status
bun Keynote.ts --read <READ.md> --list
bun Keynote.ts --read <READ.md> --move N --to M
bun Keynote.ts --read <READ.md> --set <slide> <title|sub|bullets|image|art|kind|art-type> <value>
bun Keynote.ts --read <READ.md> --redo-art <slide>[,…]
bun Keynote.ts --self-test
```

## Behaviour

- **Designs are keyed by section text.** Each section's sentences are hashed; a section with no design for its hash is designed on the next run. Editing a section therefore redesigns it, and untouched sections keep theirs. `--section` forces a redesign and shows the model the previous design so it tries something different; `--direction` adds the speaker's note to that redesign.
- **Notes can't drift.** A design only says how many sentences each slide covers, and the counts must add up to the section's length, so the builder slices READ.md directly. `--verify` reads the notes back out of the `.key` and diffs them against READ.md.
- **The deck is rebuilt every time.** Edits made by hand inside Keynote are lost on the next build. Put lasting changes in READ.md, or in the design through `--section … --direction`.
- **Style file** (JSON): `theme` (a built-in Keynote theme), `ground` and `placeholder` (`#rrggbb`), `artStyle` (art direction the designer reads), `title` / `sub` / `bullets` / `caption` tokens `{ "font", "size", "color" }`, and `footer` (a token plus `text` and an optional `logo` path; adds a page number).
- **Design file versions.** A v1 KEYNOTE.json (the seven text-led kinds) keeps its title, subtitle and style, and every section is redesigned for full/split.
- `--status` lists sections without a design and every slide still waiting on art, with its brief. `--list` prints every slide with its number, talking point, type, art type, title and image.
- **Art types.** Each slide is `essay` (an illustration) or `diagram` (a technical diagram, for slides that explain how something works). The placeholder says ART NEEDED or DIAGRAM NEEDED. `KeynoteArt.ts` makes the art.
- **Edits carry over.** KEYNOTE.json keeps each design's sentences. When a section's text changes, the earlier design with the most sentences in common (at least a third) is shown to the designer, which keeps what still fits.
- **`--move N --to M`** rewrites READ.md with talking point N at position M and saves the old file as `READ.md.bak`. Every section keeps its text, so every design survives.
- **`--set`** edits one field of one slide with no model call. `bullets` takes `a|b|c`; setting `art` clears the image.
- `--images` and `--out` are remembered in KEYNOTE.json.
- **Layout** comes from `Layout.ts`: 16:9 art bleeds only when its drawing covers the frame (padded art is trimmed and stands beside the title instead, with the title and subtitle set larger), tall pictures (covers) stand beside the title, other full-slide pictures fill the body under it, and split slides centre the bullets on a picture filling the right column. Generated art is trimmed to its drawing first (`.layout-cache/` next to READ.md). Every build exports its slides (to a temp dir without `--export`) and the pixel gate fails any slide with one empty block over 26.5% of its area. Every built slide is also measured as boxes; problems print per slide, `LAYOUT.json` keeps the measurements, and the exit code is 4.
- **Real things.** The install's `RealThings.json` (or `--real`) registers the speaker's own things with their real picture. The designer is told about each one a section names, and every build puts the registered picture on the slide whose sentences name it, as art type `media`. A line wholly in parentheses is a stage note and does not count.

## Exit codes

0 ok · 1 verification or design failure · 2 usage, file or Keynote error · 4 deck written, but a slide failed the layout check.

## Gotchas

- The scripting dictionary makes slide background fill read-only, so the ground colour is a 16:9 image on each master. Keynote keeps an image's aspect ratio, so the image has to be 16:9 already.
- Passing `imageFormat` to `export … as slide images` throws "Can't convert types". PNG is the default anyway.
- Every slide uses the theme's Blank layout and is drawn with free items, because layout names and placeholder geometry differ between themes.
- A pushed text item is not reliably the last element of `slide.textItems` (the Blank layout keeps hidden title and body placeholders), so the builder finds the new item by its text.
- Items stack in creation order, so the picture goes in first and text lands on top. Scripted text boxes are left-aligned and grow downward.
- An existing image that is not 16:9 is never cropped under the title: it stands beside it (tall) or fills the body below it (wide).
- The first build after new GIF art trims each GIF with ffmpeg (about a second each); ImageMagick's coalesce path took ~35 s per GIF.
