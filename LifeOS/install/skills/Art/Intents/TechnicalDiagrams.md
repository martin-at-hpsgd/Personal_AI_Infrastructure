# TechnicalDiagrams

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Gotchas · Examples

Excalidraw-style technical diagrams with three-tier typography and the install palette for system architectures, process flows, posts and board presentations, as a static image or as an animated GIF that draws itself.

## Ideal State

- The deliverable is a static image (the default) or an animated GIF that draws itself (Tool contract § Animated Option (GIF)); the animated path is taken when the request says animated, animate, GIF, or "draws itself", or when the diagram explains a sequence whose order is the point.
- Every label, value and arrow is factually right for the input and spelled exactly as the source spells it. One reversed arrow, misspelled label or garbled digit fails the diagram.
- A diagram whose value depends on exact text or numbers (bit layouts, hex values, worked sums, code identifiers, measured figures) is built from vector text with `Tools/AnimatedDiagram.ts`, whose `-poster.png` is the static deliverable, so no image model renders a digit or identifier.
- A 24-item story explanation of the input content existed before the diagram was composed (`/cse 24`; that command and the StoryExplanation skill are maintainer-side and not in the public release payload, so a public install writes the 24 numbered items itself), and the composition (static or animated) was constructed from it.
- The generation prompt carries every element of the diagram look: the palette ground (§ Palette), the three typography tiers, the title and subtitle (unless a blog header), 1-3 insights, architect-style object styling, and the bold directives under Gotchas.
- The ground is the flat palette ground with no grid, texture or decoration.
- The type shows three distinct tiers: an elegant wedge-serif italic title over a regular subtitle, geometric sans labels, and 1-3 condensed italic insights wrapped in asterisks.
- The title and subtitle sit top-left, left-justified. When the diagram is a blog header whose page already has the title, the image carries no title or subtitle at all. A figure inside a post's body is not a blog header: it keeps its title and subtitle, and `AnimatedDiagram.ts build` refuses a spec without them unless it sets `untitled: "blog-header"` or `"deck"` (2026-10-25: three in-post diagrams shipped as bare flowcharts after copying an untitled spec).
- The trimmed image is landscape (aspect at least 1.4, generated at 16:9 or 21:9) with the diagram spanning the full frame width.
- The DA-name signature sits in the bottom-right of the art, visible, with no blank strip beside it.
- Structure is bold black ink. The primary accent marks key components and insights, the secondary accent marks flows, and colour covers at most about a fifth of the inked area; the rest is black and grey.
- The output reads bold, high-contrast and saturated: deep, saturated accents (never lilac, lavender, seafoam or any pastel), large bold uppercase labels readable at thumbnail size (the 512 px wide blog listing), thick confident arrowheads. A bleached, thin or pastel result is never the delivered one.
- Shapes and everyday objects look drawn on a whiteboard by an architect-trained artist: Excalidraw with style, technically drawn, never cartoony.
- Animated GIF: the build order is the explanation. Each step adds the parts that make the next claim true. Edges appear only after both their nodes exist, and insights land after the structure they comment on. A viewer who watches once can retell the flow in order.
- Animated GIF: live paths move. Edges that carry work, data, or requests are `flow` edges, and their dashes keep moving through the hold. Structural relationships stay still.
- Animated GIF: the static look carries over. Bold ink on the palette ground, the primary accent (the spec theme key `purple`) for key components and the secondary (key `teal`) for flows, at most about a fifth of the frame in colour. A wedge serif for the title, geometric-sans labels, 1–3 condensed-italic insights. The DA-name signature sits bottom-right inside the art.
- Animated GIF: the complete frame is a finished diagram. The structure fills the frame below the title band with no empty quadrant. It meets every static bullet above, except the full-width trim, which the spec's frame replaces.
- Animated GIF: it opens on the finished diagram and loops cleanly. Frame 0 is the complete diagram, because a GIF's first frame is its face wherever it isn't playing: Keynote edit view and exports, PDFs, link previews. It holds for at least 3 s, fades to its underdrawing (a faint copy of itself), and the ink draws back up to the opening frame.
- Animated GIF: it is shippable as a GIF. It is 1200 px wide by default and stays under about 5 MB, so X, LinkedIn and blog pages autoplay it. A poster PNG of the complete diagram sits beside it.
- Animated GIF: it has passed the quality loop on the GIF itself and reached Downloads through `Deliver.ts`.

## Anti-criteria

- Grid lines or texture on background.
- Generic or ugly fonts.
- Cartoony or overly casual shapes or styling.
- Over-coloring (everything in the two accent colours).
- Thin, pastel, bleached output, which Nano Banana Pro defaults to and the user rejected; the prompt never uses "light", "faint", "pastel", "thin", "sketchy" or "rough" to describe the wanted style, because they bias the model toward washed-out output (negations the BOLD directives require, such as "NOT pastel", stay).
- Never put `--remove-bg` or rembg anywhere near the animated path; the ground is drawn into the frames on purpose.
- Never critique the animated path's MP4 in place of the GIF: Deliver checks that the critique's bytes are the bytes it ships.

## Inputs

The input content the diagram explains, and where the image will be used (blog header, slide, presentation, social image), which decides the title block and aspect ratio. A register the principal names (a dark blueprint, a page's own colours) replaces the palette.

## Tool contract

### Flags

| User says | Flag |
|-----------|------|
| (default), "best", "high quality" | `--model nano-banana-pro` |
| "fast", "quick", "draft" | `--model nano-banana` (faster, slightly lower quality) |
| "flux", "stylistic variety", or a diagram that stays bleached | `--model flux` |
| "draft", "preview" / (default) / "high res", "print", "large" | `--size 1K` / `--size 2K` / `--size 4K` (nano-banana-pro only). `flux` and `nano-banana` take the aspect ratio as `--size` instead (`--size 16:9`) and no resolution tier; `References/Models.md` lists the valid values per model, and the wrong form fails validation. |
| "wide", "slide", "presentation" (default for diagrams) | `--aspect-ratio 16:9` |
| "ultrawide", "panoramic", wide system diagrams | `--aspect-ratio 21:9` |
| "square" (social, compact) | Not offered: the trimmed image must be landscape (aspect at least 1.4) and Generate.ts fails anything narrower, so say so and use `--aspect-ratio 16:9` with a compact composition |
| "blog", "website" | `--thumbnail` (transparent + thumb versions; thin linework: SKILL.md Gotchas on `--remove-bg`) |
| "transparent" | `--remove-bg` |
| "variations", "options" | `--creative-variations 3` |

### Generate Command

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --intent=TechnicalDiagrams \
  --model [SELECTED_MODEL] \
  --prompt "[PROMPT]" \
  --size [SELECTED_SIZE] \
  --aspect-ratio [SELECTED_RATIO] \
  [--thumbnail if for blog] \
  --output /path/to/diagram.png
```

Full page width and the DA-name signature (principal directive, 2026-09-27): technical images render at the full width of the post column, so generate at `--aspect-ratio 16:9` (or 21:9) with the diagram spanning the whole frame width. Every technical image is signed with the DA name in the bottom-right of the artwork, visible, never out in empty canvas beside it. Generate.ts does both for `--intent=TechnicalDiagrams`: it trims to the art, stamps the signature inside it (`--no-signature` opts out), and fails any result whose trimmed aspect is below 1.4.

### Animated Option (GIF)

The same diagram, drawn on in the order the argument runs, delivered as a looping GIF. It is built as vector strokes from a spec by `Tools/AnimatedDiagram.ts` (contract: `Tools/AnimatedDiagram.help.md`) and rendered through the HyperFrames seam. No image model draws it, so every label is exact text. The same build gives the exact-text static diagram: its `Out/<slug>-poster.png` is the complete diagram.

The composition comes from the same 24-item story explanation as the static path (written by hand where `/cse` is not installed). Write it as `<project>/diagram.json` (spec fields in the help file), then:

```bash
AD=~/.claude/skills/Art/Tools/AnimatedDiagram.ts
HF=~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts
P=${LIFEOS_HYPERFRAMES_DIR:-$HOME/HyperFrames}/<slug>          # outside every git repo

bun $AD build --spec $P/diagram.json --dir $P [--force]        # prints when the hold starts
bun $HF snapshot --project $P --at <mid-build>,<holdStart+1> --out-dir $P/Stills   # look before rendering
bun ~/.claude/skills/HyperFrames/Tools/TextFit.ts --project $P --times <holdStart+1>
bun $AD gif --dir $P [--width 1200] [--fps 15]                 # Out/<slug>.gif, -poster.png, .mp4
```

Quality loop and delivery (critique the GIF; iterate on the spec, not the tool, until the bar):

```bash
ART=~/.claude/skills/ArtDirection/Tools
bun $ART/Critique.ts --video $P/Out/<slug>.gif --brief $P/Brief.json
bun ~/.claude/skills/Assay/Tools/Proof.ts run --artifact $P/Out/<slug>.gif
bun $ART/Deliver.ts --artifact $P/Out/<slug>.gif --critique $P/Out/Critique.json --to "${LIFEOS_DOWNLOADS_DIR:-$HOME/Downloads}"
```

## Output format

The static prompt is built from this template. Fill the bracketed parts from the CSE and the colours from § Palette; drop the Title and Subtitle lines for a blog header whose page carries the title.

```
Create a consistent, styled technical diagram using ALL of the styling guidelines here.

BACKGROUND: Pure flat [GROUND NAME] [GROUND HEX] — absolutely NO grid lines, NO texture, NO decorations.

STYLE: Architect aesthetic — like an architect artist did it on the whiteboard

TYPOGRAPHY (CRITICAL - use these exact font styles):

HEADER: Elegant wedge-serif italic font (like Palatino but more refined, with distinctive wedge-shaped serifs and high stroke contrast). Large size, black color, top-left position, title case.

SUBTITLE: Same elegant wedge-serif but regular weight (not italic). Smaller size, charcoal #2D2D2D color, directly below header, sentence case.

LABELS: Geometric sans-serif font (like Avenir or Futura but slightly warmer, clean and technical with even stroke weight). Medium size, charcoal #2D2D2D color, used for all box labels and component names. Hand drawn versions of this.

INSIGHTS: Condensed italic sans-serif font (sporty editorial style like sports jerseys or magazine callouts, narrow and slanted). Smaller size, [PRIMARY ACCENT NAME] [PRIMARY HEX] color, used for callouts with asterisks like "*key insight*".Hand drawn versions of this.

DIAGRAM CONTENT:
Title: '[TITLE]' (Top left, left-justified)
Subtitle: '[SUBTITLE]' (left justified to the Header, slightly below)
Art and labels and such should look like Excalidraw, but hand drawn by a talented Architect Artist that mimics our fonts.

Have 1-3 insights for each image created.
```

Then add the bold directives under Gotchas, the components and arrows from the CSE, and these settings:

| Tier | Prompt words | Size | Colour |
|------|--------------|------|--------|
| Header (wedge-serif) | elegant wedge-serif italic, high stroke contrast, not generic serif | 3-4x body text | Black #000000 |
| Subtitle (wedge-serif) | same serif, regular, sentence case, no period at the end | 1.3x body text | Charcoal #2D2D2D |
| Labels (geometric-sans) | geometric sans, warm, even stroke; box labels, node names, identifiers | medium, readable | Charcoal #2D2D2D or Black #000000 |
| Insights (condensed-italic) | condensed sporty italic, always in asterisks, e.g. "*this is the bottleneck*", "*critical path*" | 60-70% of labels | Primary accent (default) or secondary accent |

### Palette

The colours come from `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/PREFERENCES.md` § Color palette (its diagram ground, primary and secondary accent) when that section exists, else these defaults, which match `Tools/AnimatedDiagram.ts`. Name each colour by its words and hex in the prompt.

```
Ground             — Off-white #F5F5F0 (flat page ground)
Primary accent     — Deep indigo #2B4C7E: key components, insights (10%)
Secondary accent   — Deep green #3A7D44: flows, connections (5%)
Charcoal #2D2D2D   — Text, labels (5%)
Black #000000      — Primary structure (bold ink)
```

Everyday objects, when the visual needs them, are technically drawn by an architect or artist type, never cartoon-like. The whole image should look like it was made on a whiteboard by an extremely talented artist with Architect training: like Excalidraw, but more Architect / Artistic, with hand-drawn components and labels roughly in the style of the fonts.

## Gotchas

### Bold, high-contrast, saturated

Nano Banana Pro defaults to thin/pastel, which the user rejected; the prompt pushes hard for bold, saturated, crisp.

Every technical-diagram prompt repeats the following directives, more than once if needed, because without them the output comes back bleached and is rejected:

- **BOLD BLACK INK** (#000000 or near-black) for primary linework — like a **thick drafting pen or black sharpie**, NOT a light pencil
- **DEEP SATURATED [primary accent name and hex]** — must read rich and deep, NOT lilac, NOT lavender, NOT pastel
- **DEEP SATURATED [secondary accent name and hex]** — rich, NOT pale seafoam, NOT washed blue-green
- **HIGH CONTRAST** between ink and the paper ground — the image should feel **CRISP**, not soft
- **LARGE BOLD UPPERCASE labels** — must be readable at thumbnail size without squinting
- **THICK, CONFIDENT arrowheads** — no hesitation, no faint lines
- **Professional technical illustration quality** — Tufte precision, architect's drafting plate, NOT a rough student sketch
- Hand-drawn imperfection is OK but strokes MUST be **BOLD and DELIBERATE**, never thin and uncertain
- Explicitly **reject** the words "light", "faint", "pastel", "thin", "sketchy", "rough" from the prompt — they bias the model toward washed-out output

When a diagram comes back bleached, thin, or pastel: regenerate immediately with stronger directives. For stubborn cases, switch to `--model flux` — Flux tends to produce crisper, more finished technical illustration than nano-banana-pro.

### Named registers

- **A register the principal names replaces the palette ground (2026-09-04, a profile hero image).** The principal rejected the warm-paper notebook version for its brown colour and asked for a dark-mono blueprint with engineering fonts, as a PNG from authored SVG in dark and light variants. AnimatedDiagram's `theme` field puts a diagram on a page's own colours, and its `-poster.png` is a static plate.

### Animated GIF path

- **For a deck, match the deck's diagrams:** no title (`untitled: "deck"`), no signature, `strokeScale` about 1.8 and `typeScale` about 1.5, 3:2 for split slides and 21:9 (1920x824) for full ones. The Presentation skill's KeynoteArt intent places the GIF, and every Lecture build sets it to start on slide entry, so it never waits for a click.
- **Fonts come from `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/DiagramFonts.json`.** A missing role uses a generic family. The palette comes from `DiagramTheme.json` beside it (`AnimatedDiagram.help.md` § Palette). A configured file that is missing fails the build by name. The signature face lives in a system `.ttc` that cannot embed. Extract it once with `fonttools ttLib -y 0 <SignPainter.ttc> -o <cache>/SignPainter-HouseScript.ttf`, and repeat that on a new machine.
- **GIF size grows with width × duration × moving pixels.** Flow dashes repaint every frame. If a GIF runs past about 5 MB, drop `--fps` to 12 or `--width` to 1000 before you cut content.
- **The first frame is the GIF's face (principal, 2026-10-01, a Keynote deck export).** A loop starting on bare paper failed every critique on an empty frame 0. A loop starting on the underdrawing made every animated slide in the Keynote export look faded out. `gif` therefore rotates the loop to open on the complete hold, and the underdrawing (`ghost`, on by default) keeps the redraw from ever showing bare paper.
- **The critique panel reads mid-build frames as unfinished (2026-10-01, first test GIF).** In `Brief.json`, state that frames before the hold show a partial build on purpose. Otherwise the panel scores every mid-build frame as "unfinished".
- **Quantising drifts the paper by a few levels per channel**, which shows as a faint box on a slide of the ground colour. `gif` pins the paper into the palette; check a corner pixel of the GIF if you change the ground.
- **GIF has a 256-colour palette.** Flat fills and ink survive it; gradients and soft shadows band. The tool uses neither, so keep it that way.

## Examples

**Use for:** Architecture diagrams, process flows, pipelines, infrastructure maps, board presentations.

```
User: "technical diagram: TCP flags byte (tcp[13]) bit layout with hex values and three worked sums"
→ TechnicalDiagrams, exact-text route
→ An AnimatedDiagram spec with every bit, hex value and sum as vector text; the -poster.png is the static image, every digit exact
```

```
User: "blog header diagram for a post on a five-stage maturity model: the stages as a staircase, no title"
→ TechnicalDiagrams, static
→ A full-width 16:9 diagram on the palette ground with no title or subtitle, signed bottom-right, in Downloads for review
```
