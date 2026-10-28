# Tools

Which tool checks what. Each intent's Tool contract shows the flags that intent uses; `Tools/Keynote.help.md` and `Tools/KeynoteArt.help.md` hold the full flag lists.

- Lecture script: `Tools/Build.ts`. Run `--check` to validate, `--text` to print the read-through as Markdown (one sentence per paragraph, `---` between slides), `--serve` to serve the deck locally, and `--self-test` to check the tool itself.
- Deck-mode gate: `Tools/DeckCheck.ts <deck-dir> --live <url>` (real things, one press per slide, live layout). Lecture mode's Keynote build runs `Layout.ts`, `RealThings.ts` and `KeynoteAutoplay.ts` on every build; `Tools/KeynotePlayback.ts <deck.key>` proves autoplay from Keynote's own reading of any deck, including one the speaker saved.
- Server: `Tools/Present.ts --dir <deck-dir>` (F fullscreen, S speaker view, E in-place edit, `?print-pdf`)
