---
name: Presentation
metadata:
  short-description: "Makes talks and slide decks, either a read-aloud lecture built in Keynote or HTML or a cue-card HTML deck served with speaker view."
version: 1.3.1
description: "Makes talks, slide decks and sales pitches: a read-aloud lecture in Keynote or HTML, a cue-card HTML deck, or a pitch from product docs (value story, talking points, charcoal sketch). USE WHEN presentation, make me a deck, slides, slide deck, present on, give a talk on, keynote, speaker notes, present this, serve the deck, presenter mode, lecture, read-aloud talk, script for a talk, turn this essay or dictation into a talk, move this slide, reprocess the talk file, make that slide a diagram, find footage of the films I mention, make the animations autoplay, real book cover, real screenshot, too much white space, image too small, export to PPTX, sales pitch, sales narrative, sales deck, pitch deck, sales package, sales script, sales materials, product pitch, create a sales story, visual for this sales story, elevator pitch, value proposition, turn this into a pitch. NOT FOR images (Art), video (HyperFrames), web design (Webdesign), voice reading (ReadIt)."
evals:
  deterministic:
    - command: "bun skills/Presentation/Tools/Build.ts --self-test"
      falsifier: "exits nonzero when a slide with 0 or 6+ sentences, two sentences on one line, a sentence over 20 words, or an unknown TYPE passes validation, or when notes stop rendering one spaced paragraph per sentence, or when an art slide's CITE stops rendering as the bottom-left source line or pictures lose their 12 px rounded corners"
    - command: "bun skills/Presentation/Tools/Keynote.ts --self-test"
      falsifier: "exits nonzero when a design that drops, repeats or over-packs sentences validates, when an unchanged section is selected for redesign or an edited one is not, when a changed spoken word survives the notes diff, when --move loses or alters a section, when --set touches more than one field, or when an edited section does not find its earlier design, or when a Markdown heading does not start its own talking point titled with that heading, or a rewrite of a headed file loses a heading, or when a media slide whose subtitle is a credit line validates or --set source fails to write, or when a GIF repeated on any two slides or a still repeated with slides between passes as not a duplicate"
    - command: "bun skills/Presentation/Tools/KeynoteAutoplay.ts --self-test"
      falsifier: "exits nonzero when a movie-start build chunk does not read back automatic after patching, when a chunk for any other build is touched, when a patched .iwa payload does not round-trip, or when a second pass changes anything"
    - command: "bun skills/Presentation/Tools/KeynotePlayback.ts --self-test"
      falsifier: "exits nonzero when a slide whose animation step is not automatic in Keynote's export is reported clean, when a patched GIF slide or a slide whose only manual step is the final advance is reported stuck"
    - command: "bun skills/Presentation/Tools/Layout.ts --self-test"
      falsifier: "exits nonzero when art padded around a narrow drawing is allowed to bleed, when a slide with a bare half passes the pixel gate or a filled one fails it, when a book cover is not laid out standing beside its title, when split bullets are not centred on their picture, when a thumbnail-sized picture, an empty band over 30% of the slide body, a picture over text, or text in the footer passes the layout check, or when generated art keeps its paper margins, or when a real-thing still loses its transparent 12 pt corners or a GIF loses frames or its ground-coloured corners, or when one screen shown under two titles passes the look-alike check or a different screen fails it"
    - command: "bun skills/Presentation/Tools/RealThings.ts --self-test"
      falsifier: "exits nonzero when a slide whose sentences name a registered real thing keeps generated art instead of the registered picture, when a stage note in parentheses triggers it, or when a second pass changes anything"
    - command: "bun skills/Presentation/Tools/DeckCheck.ts --self-test"
      falsifier: "exits nonzero when a deck slide naming a registered real thing without its picture, a fragment build, a video without data-autoplay, a missing image, a thumbnail picture, a picture over text, overflow or a large empty band passes, or when a clean balanced slide is flagged"
    - command: "bun skills/Presentation/Tools/KeynoteMedia.ts --self-test"
      falsifier: "exits nonzero when a clip window over the length limit is accepted without --long, or when a valid window is refused"
    - command: "bun skills/Presentation/Tools/KeynoteArt.ts --self-test"
      falsifier: "exits nonzero when a diagram slide routes to any Art intent but TechnicalDiagrams or an essay slide to any but Essay, when a slide that already has an image is drawn again, or when a prompt carries the slide title or a title block"
  manual:
    reason: "whether the talk sounds like the speaker and the visuals support it needs the speaker presenting the rendered deck; the speaker view needs a real S keypress"
    falsifier: "the speaker stumbles reading a slide's notes aloud, a visual pulls attention away from what is being said, or a deck-mode slide carries more than one claim"
---

# Presentation

**Contents:** Ideal State · Intent Routing · Data & Config · Gotchas · Examples

Talks, the slides behind them, and sales pitches, in three modes.

- **Lecture mode** is a talk the speaker reads aloud from start to finish. The text is the content and the slides are there for pacing: a new slide every 15 to 30 seconds keeps the room watching, and each visual either supports the sentence being read or stays quiet. The source is a talk file (READ.md or SCRIPT.md); the deck is Keynote or HTML and is regenerated from it.
- **Deck mode** is a deck where the slides carry the argument and the speaker glances at short cues. One claim per slide, the archetype chosen from the content, built as an HTML deck on the install's template and served with speaker view.

- **Pitch mode** turns product documentation into a sales pitch: a first-person value story a buyer can retell, talking points, an elevator pitch, and for a full package a charcoal sketch (`Intents/Pitch.md`, which absorbed the retired Sales skill).

Pick lecture mode when the speaker says they will read it, or hands over a talk file or dictation to turn into a talk. Pick deck mode for "make me a deck on X". Pick pitch mode for a sales pitch, narrative or package. When it is unclear, ask once.

## Ideal State

- Every talk has an ISA before its slides do (principal, 2026-10-21). Its L3 names what the audience believes or does by the end, its criteria hold the time budget (spoken words at about 135 per minute, slide count) and the arc, and every cut, move or added slide traces to L3. A change of thesis updates the ISA first, then the order and the script.
- The speaker gets a deck they can present from: in lecture mode the notes are the talk file word for word, in deck mode every slide carries one claim and glanceable notes, and the talk file or script stays the one source the deck is rebuilt from.
- Everything real the talk names is on screen as itself: the speaker's registered things (`RealThings.json`) with their registered picture, everything else sourced through `Intents/MediaSourcing.md`. Every outside picture and clip has rounded corners (12 pt in Keynote, 12 px in an HTML deck) and its credit (film and year, site, publisher) in the small bottom-left source line, never the subtitle.
- Generated art appears only where it carries something words cannot, and every number on a chart was verified this session or its source line says "illustrative". In lecture mode, on-slide text is a few words that echo the line being read, and where a visual adds nothing a plain text slide is right.
- Every slide passes the layout and playback checks in code (balanced, pictures filling the space they were given and never crowding the title, nothing overlapping, no large empty band, nothing waiting for a click) and was looked at as rendered pixels.
- A pitch tells one value story a buyer can retell, every product claim traced to a line in the source docs, with no feature-list sentence, and its sketch carries the same register and idea (`Intents/Pitch.md`).
- No deck reaches the speaker as a first draft: its slides passed a `slides` critique (`References/QualityLoop.md`) and it arrives through `Deliver.ts` or as a served URL with the human-only keys stated.

## Intent Routing

| Mode | Intent | Trigger | File |
|------|----------|---------|------|
| Lecture | **Write** | "write a lecture on X", "turn this dictation/essay/talk into a lecture", "convert my deck to a lecture" | `Intents/Write.md` |
| Lecture | **Build** | "sync the lecture", "rebuild the deck", "I edited the script", "present the lecture" | `Intents/Build.md` |
| Lecture | **Keynote** (create) | "make the Keynote", "Keynote version of my talk", a talk file with no deck yet | `Intents/Keynote.md` |
| Lecture | **KeynoteUpdate** | "move this slide up here", "reprocess this, I changed the file", "change the title on slide N", "make slide N a diagram", "redo the slides for section N" | `Intents/KeynoteUpdate.md` |
| Both | **KeynoteArt** | "make the art for the deck", "draw the diagrams", "redo the art on slide N", slides showing ART NEEDED or DIAGRAM NEEDED | `Intents/KeynoteArt.md` |
| Both | **MediaSourcing** | "find footage of X", "show the real film", "get the book cover", "screenshot the site", `>` visual direction lines, slides showing MEDIA NEEDED | `Intents/MediaSourcing.md` |
| Deck | **CreateDeck** | "make me a deck on X", "slides for my talk" | `Intents/CreateDeck.md` |
| Both | **Present** | "serve the deck", "present it", "presenter mode" | `Intents/Present.md` |
| Deck | **ExportToClaudeDesign** | "push to Claude Design", "export to PPTX" | `Intents/ExportToClaudeDesign.md` |
| Pitch | **Pitch** | "sales pitch", "sales narrative", "elevator pitch", "value proposition", "turn this into a pitch", "create a sales package", "a visual for this sales story", "sales script", "sales materials", "product pitch", "create a sales story", "sales deck" or "pitch deck" (the pitch first, then CreateDeck when slides are wanted) | `Intents/Pitch.md` |

| File | Read when |
|------|-----------|
| `References/TalkFiles.md` | reading, writing or rebuilding from a talk file (READ.md, SCRIPT.md, a speaker's Markdown): how its lines become talking points, titles and notes |
| `References/QualityLoop.md` | before any deck goes to the speaker: the `slides` critique, what `Deliver.ts` accepts |
| `References/KeynoteGotchas.md` | every Keynote, KeynoteUpdate, KeynoteArt or MediaSourcing run: dated Keynote, layout and autoplay failures |
| `References/HtmlDecks.md` | building, capturing or serving an HTML deck (Build, CreateDeck, Present, ExportToClaudeDesign) |
| `References/Tools.md` | which tool checks what, or a tool no intent shows |
| `ScriptFormat.md` | writing or validating a lecture SCRIPT.md: its fields and slide types |
| `DesignSystem.md` | authoring a deck-mode slide: the default tokens and type, the nine archetypes and how to choose; an install's own `DesignSystem.md` in the customization dir overrides its brand sections |
| `Tools/` | a tool's flags beyond what an intent shows: `Keynote.help.md`, `KeynoteArt.help.md` |
| `Setup.md` | first-time setup: the deck template, the real-things registry, and what the Keynote, media and layout-check lanes need installed |


## Data & Config

Before running, check `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/` (`configRoot` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`). What can live there:

- `PREFERENCES.md`: template, theme, Keynote style file, where talks live, where the speaker's own material is, and the quality gates this install requires. It overrides the defaults here.
- `DesignSystem.md`: the install's own slide register (tokens, type roles, footer band, signature elements), read in place of those sections of the skill's default `DesignSystem.md`.
- `Config.md`: the presenter's byline, site, handle and organisation for deck credits, and paths to their published writing.
- `Template/`: the HTML deck template (`deck.html` exemplar, `theme.css`, fonts, a vendored reveal.js with the notes plugin and `editor.js`, brand images). Fonts in a template are often licensed for one person, which is why the template lives here and never in the skill.
- `RealThings.json`: the speaker's own real things (a book, a product, a site) with the one true picture of each; see `Tools/RealThings.ts`.
- `History.md`: which of the install's own deck builds each dated gotcha came from. Provenance only; no run reads it.

First-time setup for these files and the tools each lane needs is in [Setup.md](Setup.md).

## Gotchas

- **Keynote AppleScript cannot delete through a live `repeat with im in images of slide N` reference** (2026-10-21): it fails with "Can't get item 1 of every image of slide N" even when the slide holds that image. Take the list first (`set imgs to every image of slide N of d`, then `item i of imgs`) and delete from it. The same failure was first misread as "Keynote cannot work while the screen is locked"; Keynote answers AppleScript and edits decks with the screen locked.
- **A sentence that names a real film, character, product or person is a media ask even without a `>` direction.**
- **A reference deck put a drawn book where the real cover belonged** (2026-10-02): the slide naming the speaker's own book carried an essay illustration of an open book. Real things are `media` now, and registered ones are enforced in code on every build.
- Mode-specific gotchas: Keynote builds in `References/KeynoteGotchas.md`, HTML decks in `References/HtmlDecks.md`, lecture writing in `Intents/Write.md` § Gotchas.

## Examples

**Example 1: Dictation to lecture**
```
User: "Turn yesterday's two recordings about the harness idea into a 30-minute lecture"
→ Write: pulls the recordings, drafts SCRIPT.md in the speaker's own words,
  ~100 slides, each with READ lines, visuals chosen where they help
→ Build.ts --check passes; deck built; every slide checked in the browser
→ Returns the deck URL, word count and minutes, and which slides have art
```

**Example 2: A cue-card deck from an idea**
```
User: "Make me a deck on why prompt injection is the new SQL injection"
→ CreateDeck: pulls the speaker's prior lines, drafts the arc, picks an archetype
  per slide, writes glance notes, assembles from the install Template/, checks every
  slide in a pixel capture, serves it with Present
→ Returns the URL and the keys (F fullscreen, S speaker view, ?print-pdf)
```
