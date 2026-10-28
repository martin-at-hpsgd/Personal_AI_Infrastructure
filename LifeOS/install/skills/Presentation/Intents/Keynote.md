# Keynote

Creates a new Keynote deck from a talk file: a `.key` whose presenter notes are READ.md word for word, with slides designed section by section by the top model tier `Keynote.ts` designs with.

## Ideal State

- `--verify` passes: every sentence of READ.md is in the notes, in order, unchanged.
- The deck follows the file's structure: one talking point per heading or dash section, in file order, and every heading the speaker wrote is the exact title of its point's first slide (`--list` shows them). No `>` direction or stage note appears in the notes.
- The build reports `✓ layout: every slide balanced` (exit 0, not 4), on both the measured boxes and the rendered pixels: no slide has one empty block of bare ground over 26.5% of its area (`../References/KeynoteGotchas.md`), full-bleed art is reserved for drawings that fill their frame, anything narrower stands beside a title set large enough to fill its column, split bullets sit centred on their picture, and no slide body is more than 30% empty. Soft-picture warnings are resolved with a larger source when one exists.
- The speaker's registered things (RealThings.json) carry their registered picture, applied by the build, and every other book, site, app, product, film or person the talk names is a `media` slide sourced through `MediaSourcing.md`.
- Every design in KEYNOTE.json records the model that made it, and each is the design tier `Keynote.ts` asks for, never a fallback or `unknown`.
- The exported slide images (`--export`) have been viewed as a contact sheet and the flagged slides at full size: nothing clipped, overlapping, blank or swimming in empty space, picture and text in proportion, and the headline sizes and styles consistent across sections. Sections designed in parallel can drift in numbering or casing ("Two:" next to "4."). Fix that with `--section N --direction` on the outliers.
- A redesign changed only the sections that were asked for or edited. Diff KEYNOTE.json before and after.
- The deck reached the speaker through `Deliver.ts --artifact "<dir>/<Talk Name>.key" --to <review folder>`, on a passing `slides` critique (`--out <dir>`) of slides exported after the last build, with the first slide proofed (`../References/QualityLoop.md`).
- Every slide has an art type. Most are `essay` (an illustration). A slide that explains a structure, a flow, a loop or layers is `diagram`, a few per talk and never two in a row. A slide naming a real book, site, app, film, character, product or person, or answering a `>` direction for footage, is `media`, one named thing per slide. `--list` shows them; change one with `--set <slide> art-type diagram|media`.
- Every animation (GIF art and media clips) starts by itself when its slide appears, as the build's `Tools/KeynotePlayback.ts` run reports; the `KeynoteAutoplay.ts` count is not that proof (`../References/KeynoteGotchas.md`). A deck the speaker edited and saved is checked with `bun Tools/KeynotePlayback.ts <deck.key>`. Slide advance stays on the click.
- There is exactly one deck to present: the build reports no copy autosaved into iCloud.
- No two slides show the same picture or the same screen, back to back included, unless the speaker asked for the callback; a slide with no exported image is itself a layout failure (exit 4).
- No slide reaches the speaker still showing ART NEEDED, DIAGRAM NEEDED or MEDIA NEEDED: essay and diagram art came through `KeynoteArt.md`, media through `MediaSourcing.md`, and the deck was rebuilt with it. Both legs start as soon as the first build has marked those slides and run side by side, since neither waits on the other. Placing each result into the deck is serialized (both rewrite `KEYNOTE.json`), and the rebuild, `--export` and slides critique wait until both legs have finished.

## Anti-criteria

- Never loosen the layout thresholds in `Layout.ts` to pass a deck; change the slide.
- No generated picture stands in for a nameable thing, and no media credit sits in the subtitle.
- No `>` direction or stage note is ever spoken or put in the notes.
- The deck never reaches the speaker by a plain copy or as an iCloud autosaved duplicate; it goes through `Deliver.ts` after a passing slides critique.

## Output format

Hand back the path of the `.key` the build wrote, the slide count, how many essay and diagram slides there are, and which slides fell short of the art bar.

## Inputs

Use this when the speaker hands over a talk file (Markdown; its headings and dash lines mark the talking points) and there is no deck for it yet. Changes to an existing deck (a moved talking point, an edited talk file, a retitled slide, new art) run through `KeynoteUpdate.md`; making the art runs through `KeynoteArt.md`. Every slide is **full** or **split** (bullets left, picture right). A full slide's picture bleeds edge to edge when it is 16:9 art, stands tall beside the title when it is a cover or other tall picture, and otherwise fills the body under the title. `Tools/Layout.ts` owns those placements.

- `READ.md`: the talk file, in the Markdown format in `../References/TalkFiles.md`. A talk file under another name is copied to READ.md in its talk folder unchanged. `Build.ts --text` prints a READ.md from a SCRIPT.md if only that exists.
- `KEYNOTE.json` (next to READ.md, created on first run): one design per section, keyed by a hash of the section's text. It also remembers the title, subtitle, style and theme, so later runs need only `--read`.
- An optional style file (`--style`): a built-in theme, ground and placeholder colours, the art style, type tokens for title, subtitle, bullets and captions, and a footer. PREFERENCES names the install's style file.
- Images the designer may use: `<dir>/images` or `<dir>/deck/images`, or `--images <dir>`.

## Tool contract

**A run is a Workflow at the tier its parts set** (Router ISA F8, Algorithm § Routing; OPERATIONAL_PREFERENCES § Workflows is the opt-in): the parts this intent runs at the same time become lanes of a script written for that run, the dependent steps stay in order, and the main session stays the only writer of the deliverable.

```bash
T=~/.claude/skills/Presentation/Tools/Keynote.ts
bun $T --read <dir>/READ.md --title "<talk title>" --subtitle "<subtitle>" --style <style.json> \
       --out "<dir>/<Talk Name>.key" --export <dir>/keynote-png          # first build
bun $T --read <dir>/READ.md --out "<dir>/<Talk Name>.key"                # after edits: redesigns changed sections only
bun $T --read <dir>/READ.md --section 14 --direction "<what to change>"  # redesign one talking point (comma-list for several)
bun $T --read <dir>/READ.md --status                                     # which sections lack a design
bun $T --read <dir>/READ.md --verify "<dir>/<Talk Name>.key"             # notes read back == READ.md
bun $T --read <dir>/READ.md --real <RealThings.json>                 # a registry other than the install's
bun $T --self-test
```

Exit 4 means the deck was written but a slide failed the layout check; the lines above it name each slide and the problem.

### Intent to flags

| Speaker says | Flags |
|--------------|-------|
| "make the Keynote", "build the deck" | first-build line |
| "just the designs, don't open Keynote" | `--design-only` |
