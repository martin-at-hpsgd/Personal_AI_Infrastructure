# Present

Serves an existing deck directory for presenting, with speaker view, in-place editing and PDF export.

## Ideal State

- The deck is served over HTTP by `Present.ts`, running in the background, and the served URL answers 200.
- The principal has the printed URL and the human-only steps surfaced to them: open it in their browser (the install's Presentation `PREFERENCES.md`, else the system default), F for fullscreen on the external display, S for the speaker window on the laptop, E for in-place editing, and `?print-pdf` for PDF export.

## Anti-criteria

- The deck is never opened directly from `file://`; speaker view requires HTTP.
- The human-only steps are surfaced, never automated: the S popup needs a real keypress.

## Output format

### What the principal does (human-only steps — surface these, don't automate)

1. Open the printed URL in the principal's browser (the install's choice in its Presentation `PREFERENCES.md`; on macOS `open -a "<Browser>" "http://localhost:<port>/"`, or plain `open` for the system default).
2. Drag the window to the external display, press **F** — fullscreen slides.
3. Press **S** — speaker window opens on the laptop: current + next slide,
   notes, elapsed timer. Arrow keys advance both, synced.
4. Press **E** — in-place editing (Keynote-style): click any text or the
   presenter-notes panel, type, **Done** or **⌘S** saves straight back to
   deck.html. A thumbnail sidebar (Keynote navigator) appears on the left:
   click a thumbnail to jump, drag to reorder slides (persisted on drop).
   **Esc** in present mode is the light-table overview of every slide.
   Arrow keys are paused while editing.
5. PDF export: append `?print-pdf` and print to PDF.

## Inputs

For a deck directory that already exists (built by CreateDeck or the
original prototype).

## Tool contract

```bash
bun ~/.claude/skills/Presentation/Tools/Present.ts --dir <deck-dir> [--port 7345] [--deck deck.html]
```

Run it in the background; confirm with `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/` → 200.

## Gotchas

- Port collision: Present.ts dies loudly if 7345 is taken — pass `--port`.
- In-place editing requires the `<!-- SLIDES:START -->` / `<!-- SLIDES:END -->`
  markers inside `<div class="slides">` and `vendor/editor.js` — both come
  from the install's customization `Template/`. `/save` fails loudly (never corrupts) if markers are missing.
- The editor's save strips reveal.js state classes and skips the marker
  comments; the server splices first-START to last-END and binds 127.0.0.1
  only, so venue wifi never sees the edit endpoint.
