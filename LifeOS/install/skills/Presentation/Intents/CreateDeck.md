# CreateDeck

Idea in, presentable deck out (built on the install's template): a self-contained deck directory the principal can present from tonight, in their voice, with presenter notes on every slide, served locally with Keynote-style speaker view.

## Ideal State

- A directory `LIFEOS/MEMORY/WORK/<slug>/deck/` containing `deck.html`, `theme.css`, `fonts/`, `vendor/`, and `images/` (deck-specific art only), fully offline-capable, with slides in the principal's voice on the active design system (`../DesignSystem.md`, or the install's `DesignSystem.md` in its Presentation customization dir when that exists), presenter notes on every slide, served locally with Keynote-style speaker view.
- The copy reuses the principal's actual prior lines and framing on the topic wherever they exist (found through a content-search skill, if one is installed); fresh invention fills only the gaps.
- The deck reads as one argument, not a stack of slides, with a CSE-style arc: a hook that earns attention → escalation → the turn, the one crafted one-liner where the idea flips → a close that lands. If the hook, the turn and the close cannot be named, the arc is not there yet.
- One claim per slide: every slide carries one idea a listener could repeat back an hour later. Two claims means two slides.
- Every slide is one of the active design system's nine archetypes (`../DesignSystem.md`, overridden by the install's `DesignSystem.md` in its Presentation customization dir when that exists), built on its tokens and `.v` wrapper contract, and chosen by its selection judgment: the content picked the shape (a real dichotomy gets Two-column, one sentence worth pausing on gets Statement), and no slide breaks its copy rules.
- Slides carry punchlines, notes carry glanceable cues: every `<section>` ships `<aside class="notes">` with what to say, pacing beats ("land it, then pause"), and story prompts, as cues, not a script; each slide's notes read at speaking distance in one glance.
- It makes its case with the speaker muted: read cover to close with no narration, the deck still argues its point.
- Art appears only where it earns a beat of quiet and carries something words cannot. The default is sparingly (1-2 slides in a 10-slide deck, zero is legitimate). Existing blog art is reused when the topic already has it (the `BLOG.ART_DIR` assets from the skill's private Config.md via a search of your own published corpus, when the install has one); otherwise `Skill("Art")` Essay-intent charcoal technique, transparent PNG on the white content ground.
- Charts are inline SVG in the active design system's chart register, with the `dataviz` skill loaded before writing chart code: the register's accent color as the series on white, thin marks, recessive grid, selective labels, single axis. Chart data is session-verified or the source line visibly says "illustrative".
- Copy passed the writing gates before the principal sees it: the install's writing-audit skill in DETECT mode where it has one plus a real `PangramScore.ts` run on the assembled slide copy and notes, reported as a `✍️ WRITING-AUDIT:` line (the install's operational rules treat a deck as authored publishable prose).
- Real things are on screen as themselves (cover, screenshot, footage, photo), per `../SKILL.md` § Ideal State; in an HTML deck the 12 px corners are CSS `border-radius:12px` on the `<img>`/`<video>`.
- Every slide is balanced and nothing waits for a click. Pictures fill the space they were given, nothing overlaps or runs off, no slide has a large empty band, and a slide moves on with one press: videos carry `data-autoplay muted loop playsinline`, GIFs loop. `Tools/DeckCheck.ts --live` exits 0 on the served deck.
- Every slide has been looked at in a real browser: an Interceptor pixel screenshot of every slide judged as a design whole, and each slide's note confirmed rendering with `?showNotes=true`.
- Every slide was captured into `<dir>/deck-png/` and passed a `slides` critique with `--out <dir>` (`../References/QualityLoop.md`) before the deck was handed back.

## Anti-criteria

- No decorative filler images: an image that merely restates the header is AI-slop.
- No fabricated-but-plausible chart numbers: that is the one unforgivable failure, and a fake chart in a presented deck cannot be taken back.
- No generated art stands in for a real thing: generated art is for abstract ideas only, and a picture's credit is never in the subtitle.
- No `fragment` builds, and nothing on a slide waits for a click.
- Bullet creep is the failure, not the baseline.
- Never claim the speaker view verified without a real human S keypress, and never downgrade the verification to curl.

## Output format

After the slides critique, hand back: the local URL, the keys (F fullscreen on external display, S
speaker view on laptop, `?print-pdf` for PDF export), the WRITING-AUDIT
line, and one line on what art/chart decisions were made and why. Optional
Claude Design leg: `Intents/ExportToClaudeDesign.md`.

## Inputs

Before building, the idea, the audience and the occasion are known. A workable gap gets a one-line ambiguity flag
(`⚠️ Picking X over Y because R; redirect if wrong.`) and a best-effort deck.
A structural gap (no idea what the talk is for) gets ≤3 questions with a
`proceed` override. Deck length defaults to 8-12 slides unless told otherwise.

## Tool contract

- Start from the install's customization `Template/` (`LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Presentation/Template/`): copy `theme.css`, `fonts/`, `vendor/` and `images/`
  into the deck dir verbatim (the template's `<img>` tags expect its brand
  images there). Its `deck.html` is the canonical markup for all
  nine archetypes — author the new `deck.html` against its patterns
  (reveal.js init block included: 1280×720, fade, `c/t` slide numbers,
  notes plugin, folio div).
- Art assets: rasterize into `images/` inside the deck dir; `<img>` paths
  relative.
- Serve: `bun ~/.claude/skills/Presentation/Tools/Present.ts --dir <deck-dir>`
  (port 7345 default; pick another if taken).

- `bun ~/.claude/skills/Presentation/Tools/DeckCheck.ts <deck-dir> --live http://127.0.0.1:<port>/`
  with the deck served: real things, extra presses, video autoplay, missing
  images, and every slide measured in the Interceptor test profile. Exit 4
  names each slide to fix.
