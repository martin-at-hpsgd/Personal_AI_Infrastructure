# Voice

The author's post, read in one voice, becomes a video in review state with every visual fitted to the spoken words.

## Ideal State

- `Source/narration.json` was read before synthesis, and the narration is the author's own content only: body paragraphs and unattributed block quotes (the author's own writing set off in a block: imagined dialogue, inner voice, hypothetical lines, examples), with attributed quotations, callout boxes, pull quotes that repeat body text, asides, captions, embeds, related-post cards, tables, fenced code, notes and footnotes sections, and any paragraph matching `Config.json` `skipParagraphs` (Setup.md § Supported post format) left out of the read and on the page, unless overridden in `Source/narration-overrides.json` (tables and fenced code never).
- The page reads like the live post: every embed, link card and link renders as it does on the live page, never as a loading state, a blank frame or a missing card, and the corner badge names the right reader and author (the DA's portrait and read-by line on a DA-read run, the author's on their recording or clone).
- The inserts come from what the post argues: a Direction from the `meaning` stage that passed its two-vendor review (or the best round taken with `--accept-review-shortfall` and said in the report, or a hand-written `Plan.json` that won, said by the stage), and each insert's timing is the timing of the paragraphs it covers.
- `Out/verify.json` is all green (format, encode (x264 CRF ≤ 12), read scale ≤ 1.0, duration, frames, sheet, speech WER ≤ 8% against the post's words, loudness at −14 LUFS ± 1 with true peak ≤ −0.5 dBTP, presence, PII run) and `Capture.ts --verify` found rects for ≥ 90% of sentences.
- Frames read: at three word midpoints the highlighted sentence is the one being spoken; the page is framed, readable, and still while it is read; inserts land on the paragraph they belong to.
- The run lives in the runs root (`Config.json` `runsRoot`), never inside a git repo, and `Out/review/` holds the studio pass, one look each before anyone scrubs the file.
- The ArtDirection critique ran with `--direction <run>/Meaning/Direction.rendered.json` and `--out <run>`, so `<run>/Critique.json` carries a rationale verdict for every beat (SKILL.md § Quality loop); the mp4 reached `~/Downloads/<slug>/` through `Deliver.ts`, with `description.md` copied beside it.
- For a recording: the TightCut gate passed with zero kept words lost, and every held span was ruled by ear.
- The render passed the Assay video eval set (`video-eval`) in `Run.ts`'s `eval` stage, minus the checks `## Evals` switches off, each for its stated reason: no check failed and no code check went unmeasured, and the report names `Out/eval/video-eval.json`, the receipt and any judged flags.

## Anti-criteria

- Never reads a quotation or other out-of-band block as narration, and never drops an unattributed block quote that is the author's own writing: the test is who the words belong to, never the markup.
- A wrong block decision is never fixed by editing the post; it is overridden in `Source/narration-overrides.json`.
- A held span is never approved unheard.
- Inserts never come from keywords, and insert timing is never chosen.
- Nothing uploads: publishing is the author's separate call (SKILL.md § Ideal State).

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run by `Run.ts`'s `eval` stage on every render, plus the checks Assay compiles from the Ideal State and Anti-criteria above.
  - disabled: watermark-badge, watermark-zone — a voice run wears the reader badge (portrait, headline and read-by line), not the essay avatar disc the badge template and the zone mask are built around.
  - disabled: voice-identity, voice-pace — the narration is the author's recording or clone, or a DA read that `Ingest.ts` synthesizes, and neither the Narrate.ts chunk voice record nor the DA pace applies; `voice-wer` still holds the words.
  - disabled: motion-share, motion-max-still, visual-variety — the page is the default picture and holds still while it is read (Ideal State above), with an insert never two in a row; `visual-cadence` still requires a change at least every 8 s.

## Inputs

Two inputs: the post (`<post.md | url>`) and exactly one voice source, as below.

A post plus a voice → a finished video in review state. The voice is the author's own recording of the post, their synthesized voice clone reading the post's exact text, or the DA reading the post's exact text in its own voice (it is more authentic when the DA reads the author's actual words than when a clone imitates them). The author's words are the product; every visual is fitted to them.

## Safety gates

`Clean` exits 3 when a cut would remove a negation, a number, or a correction. Listen to each held span with its neighbours, then rule it: `Clean.ts --run <slug> --approve 3,5 --reject 7`. Rulings persist in `Narration/rulings.json` for that recording, so a re-run never re-holds them. A held span is never approved unheard. `Clean` exits 4 when TightCut's own gate refuses the render (a lost word, a bad seam, or audible filler residue). Nothing downstream is written, and the gate file it prints names the cause.

## Tool contract

```bash
bun ~/.claude/skills/VideoEssay/Tools/Ingest.ts --run <slug> --post <post.md | url> --audio <recording>   # the author's recording
bun ~/.claude/skills/VideoEssay/Tools/Ingest.ts --run <slug> --post <post.md | url> --clone               # the author's clone reads the post text (= --narrator clone)
bun ~/.claude/skills/VideoEssay/Tools/Ingest.ts --run <slug> --post <post.md | url> --narrator da         # the DA reads the post text in its own voice
bun ~/.claude/skills/VideoEssay/Tools/Ingest.ts --run <slug> --post <draft.md> --narrator da --label <DA NAME> --capture-url http://localhost:5173/drafts/<slug>   # the DA reads a draft it wrote
bun ~/.claude/skills/VideoEssay/Tools/Run.ts --run <slug>                  # clean → align → plan → meaning → lint → capture → build → verify → describe
bun ~/.claude/skills/VideoEssay/Tools/Run.ts --run <slug> --from plan --polish   # re-direct after a change; one polish round after the review passes
```

Exactly one source per ingest: `--audio`, `--narrator clone|da`, or `--clone`. A synthesized read is one take, best of N seeds; a per-run `pronunciations.json` (with the user's `PRONUNCIATIONS.json`) respells the spoken copy only, so a misspelling in the post can be spoken right while alignment and the speech check still match the post's own words. A DA-read run wears Config.json `narrators.da` in the corner: the DA's portrait, the author's `ACTUAL WORDS` headline, and a read-by line naming the DA, never the clone credit.

An author who records the audio reads the same narrated content, and alignment expects exactly that.

The inserts come from what the post argues, never from keywords. `Meaning.ts` (the `meaning` stage) maps the post into claims, units and an emotional arc, directs every paragraph group as page or insert with a written rationale, and has two judges on two vendors review that Direction before anything renders, revising up to two rounds. The passing Direction compiles into `Plan.json` and the beats are re-planned from it.

- A failed review stops the run and prints every defect. Fix the cause (usually the map misread the post; read `Meaning/review.json` and `Meaning/rounds/`), or pass `--accept-review-shortfall` to go on with the best round, and say so in the report.
- A `concept` insert renders as its declared fallback today. One with no fallback, or a book or video card, is listed as unrenderable: its paragraphs stay on the page until the composition gains a form for it.
- A hand-written `Plan.json` (one the stage did not write, or a compiled one edited by hand) wins, and the stage says so. Its shape: `{ "inserts": [ { "paragraphs": ["p4"], "visual": { "type": "compare", "left": {...}, "right": {...} } } ] }`; linked pages are loaded once in the Interceptor test context before they go in.

## Gotchas

- **A block quote is not always someone else's words (dialogue between two people inside a post is the author's writing, not a quotation).** The attribution test is `classifyBlock` in `Ingest.ts` (its doc comment lists every signal), and each decision with its reason lands in `Source/narration.json`. The override file's shape is `{ "b3": "skip", "<text prefix>": "narrate" }`; an override that matches no block fails the ingest. `---` after a quote is a rule, not an attribution. Out-of-band blocks stay on screen as part of the page, and their links stay available as insert candidates.
- **Drift is fixed by picking takes and in post, never by a voice setting.** Narration is synthesized on Fish Audio (`fishSynthesizer` in `Narrate.ts`), which has no stability dial and no request stitching. `Ingest.ts` packs the post into as few takes as `REQUEST_CHAR_LIMIT` in `Narrate.ts` allows (5,000 characters), Fish splits anything longer than `FISH_CHUNK_LIMIT` (2,500 characters) on sentence boundaries, and `Ingest.ts` keeps the steadiest of N takes (`[principal.voice] takes`, default 3; every score in `Narration/takes.json`).
- **Voice-mode narration: paragraph level match, then the linear lock, never `--level` and never a bare loudnorm.** `Clean.ts` holds each paragraph flat at the take's median (`Narration/paragraph-levels.json`), then AudioEditor `LoudnessLock` locks −14 LUFS / −1 dBTP. `--level` is off on purpose: its peak-driven leveler puts loudness spread back between matched paragraphs. `Verify.ts` holds voice renders to −14 ± 1 LUFS with true peak ≤ −0.5 dBTP. Essay mode stays on −16 LUFS (`Verify.test.ts` "loudness check").

## Output format

A good Direction here: the post is the default picture; an insert replaces it only where it carries a claim better than the page (a number → `stat`, a list or framework → `points` or `diagram`, a contrast → `compare`, the same journey at different speeds → `race`, a line worth holding → `quote`, a linked page → `scroll` or `screenshot`); about one per 30–60 s; never two in a row; never over the opening paragraph; every word on an insert is the author's, verbatim or cut down. The validator and the plan lint enforce the mechanical half.
