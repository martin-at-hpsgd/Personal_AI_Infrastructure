# Write

Material in, read-aloud lecture out: a lecture the speaker could stand up tonight and read straight through.

## Ideal State

- A lecture directory holds `SCRIPT.md` (in the format from `../ScriptFormat.md`), the built `deck/`, and any art.
- The text is the speaker's own: every line traces to their material (dictation, recordings, essays, past talks, or the corpus sources named in PREFERENCES), tightened and ordered, never invented. It sounds like the speaker, and read aloud, nothing trips the tongue.
- The notes are the talk: `Build.ts --text` prints every slide's notes in order, and that printout reads as one complete talk in the speaker's voice, with nothing missing that a listener needs. The arc holds without the slides: an opening that earns attention, a clear turn, and a close in the speaker's words.
- One beat per slide, and every slide reads in a breath: each slide carries one beat of the spoken argument in 1 to 5 short READ sentences, one per line, with a blank line between. Sentences aim for 15 words or fewer and never run past 20. A beat that needs more is split into two slides, because squeezing it would make a long sentence.
- Length matches the time slot: total read-aloud words come to about 140 per minute of the slot, unless the speaker wants room to ad-lib. A 30-minute lecture is around 4,000 words, which works out to 80 to 120 slides. The actual total and the minutes it comes to are reported.
- Each visual is chosen for its sentence: the slide type follows what's being said (a comparison gets `two-col`, a single claim gets `statement`, a picture gets `art`), most slides can be text-only, and art follows the install's art rules. Real things, corners, credits, layout, chart numbers and on-slide text follow `../SKILL.md` § Ideal State.
- It's verified in the browser: `--check` exits 0 with every warning fixed that can be (a long sentence stays only if it reads naturally aloud), every slide renders, and real-browser captures with `?showNotes=true` of the title, every `art`/`video` slide, and a sample of the rest show each slide's notes as spaced lines.
- The install's gates pass: the writing audit and visual quality loop that PREFERENCES names for published prose and artwork ran on the lecture.
- Before hand-back, every slide was captured into `<dir>/deck-png/` and passed a `slides` critique with `--out <dir>` (`../References/QualityLoop.md`).

## Anti-criteria

- A position the speaker hasn't stated is never a sentence in the talk; it is a question for them.
- No slide carries more than 5 sentences and no sentence runs past 20 words.
- No glance-cue notes: READ is the only spoken field, because the speaker reads every word.
- No picture or screen appears on two slides, back to back included: to the audience that is a duplicate slide.
- A generated illustration never stands in for a real thing the talk names, and a credit never sits in the subtitle.

## Output format

After the slides critique, hand back the deck URL, the slide count, the read-aloud word count and minutes, and a line on which slides carry art and why.

- Tell the speaker to press **S** for speaker view, since that step can't be automated.

## Inputs

Check that you have the speaker's material, the time slot, and the audience. A small gap gets a one-line flag (`⚠️ Picking X over Y because R; redirect if wrong.`) and a best-effort draft. If there's no source material at all and no clear subject, ask up to 3 questions and offer a `proceed` override. With no time slot given, ask once. If the speaker says to proceed, default to 30 minutes.

## Tool contract

```bash
bun ~/.claude/skills/Presentation/Tools/Build.ts --script <dir>/SCRIPT.md --check            # validate
bun ~/.claude/skills/Presentation/Tools/Build.ts --script <dir>/SCRIPT.md [--template <dir>] # build deck into <dir>/deck
bun ~/.claude/skills/Presentation/Tools/Build.ts --script <dir>/SCRIPT.md --text             # the read-through
```

The first build copies `deck.html`, `theme.css`, `fonts/`, `vendor/`, and `images/` from `--template` (or the template set in PREFERENCES). Without a template, it writes a plain shell that loads reveal.js from a CDN. Later builds only replace what sits between the `<!-- SLIDES:START -->` and `<!-- SLIDES:END -->` markers.

## Gotchas

- **"Short" means short to say aloud, not short to read.** A 19-word sentence with two commas passes the hard limit but is hard to deliver. Treat the 15-word warnings as places to split, not as noise.
- **In lecture mode, glance cues are the wrong model.** A deck whose notes were ≤15-word cue cards was rejected because the speaker reads every word. The old CUE/FULL split, with a short cue and a long reference paragraph, doesn't fit a lecture. READ is the only spoken field. (Reference talk, 2026-09-30.) Deck mode's glance notes are a different deliverable.

## Examples

**Convert a cue-card deck**
```
User: "Make my existing talk a lecture, I want to read every slide"
→ Write: rewrites each slide's notes into READ lines from the full script,
  splits dense slides so no slide needs more than 5 sentences
```
