# SystemFilm

A 15–40 s film of one real system running, drawn as a live dashboard that wakes up phase by phase: its parts as glowing cards of label and value rows, its real connections as edges with signals travelling along them over a slow dot grid, counters ticking, a run log filling line by line, and the run's outcome held at the end. The look and every value come from data, so a new film is a new script, never new animation code.

## Ideal State

- **It shows a real run.** Every card, row value, phase, counter and log line traces to a source named in `script.json` (`source`): a STATVS query, a workflow run, an ISA, a command's output. Values the source does not hold are absent, not invented. When the principal asks for an illustrative film, the script sets `illustrative: true` and the frame says so in the footer.
- **The phases are the system's own stages, in its own order.** The script's `phases` are the stages the system actually moves through (a workflow's steps, the Algorithm's phases, a pipeline's lanes), and the header names the current one. That order is the film's direction, so no VideoMeaning map is made; `STORYBOARD.md`, which `Tools/SystemFilm.ts` writes from the script, is the plan `Proof.ts plan` checks against `BRIEF.md`.
- **One idea, stated before building.** `BRIEF.md` says which system and which run, the one thing the film shows (the gate that held, the cost that stayed low, the load it carried), and its source. The last phase lands on that point and holds it at least 2 s.
- **Attention is lit.** In each beat one card is focal: it glows in the house accent while idle cards sit dim. The signals on the real edges and the dot grid under them move the whole time, quietly, so no frame is still and none competes with the focal card. No line is drawn that the system does not have.
- **It is in our colours.** Palette, type, eases and glow come from `Tools/Theme.ts` (the install's `Theme.json` over the default), with the accent family for structure and the semantic colours (success, warning, error) only on values that mean them. No hex is hardcoded in a script.
- **The camera goes where the work is.** The film opens on the whole system and returns to it at each phase change. Between those, it goes close on the part each event changes (the card being worked, the log as a line lands, the output as it settles), one part per shot, with a slow push in and back out inside every shot, so the picture never holds still and the viewer always sees what just changed.
- **It can be an animated terminal.** With `look: "terminal"` the same script renders as a terminal window: a title bar, a legend naming up to five roles in their colours, flat boxes bordered in their role's colour, dotted edges marching toward their target, and a prompt line that types the command that runs the system over a status ticker. Who does what reads from colour alone, and the prompt's command is the real one.
- **It reads with the sound off.** Labels are monospace with tabular digits, every value change and log line holds long enough to read, and `Tools/TextFit.ts` passes at every event time.
- **The default frame is 1080×1350 at 30 fps**, the 4:5 portrait that fills a feed; 1920×1080 and 1080×1920 on request, from the same script.
- **The render chain is the skill's.** Built by `Tools/SystemFilm.ts`, rendered through the seam, Proof run on the storyboard, first stills and final encode, and, unless the ask was "visualize" or "explain" for the principal's own understanding, the ArtDirection loop and `Deliver.ts` before it reaches the principal (SKILL.md § Ideal State).
- **The final encode passed the eval set.** It rendered with `render --eval` naming this intent, so the Assay video eval set (`video-eval`) measured it minus the checks `## Evals` switches off with their reasons, and no check failed or went unmeasured.

## Anti-criteria

- No made-up number presented as real: a film whose script lacks a `source`, or holds a value its source does not, is not rendered.
- No private data in a film meant for anyone but the principal: no email address, secret, home path, customer name or private repo name in any frame, and the release deny-list scan reports zero hits before it is shared.
- No hand-authored composition in place of the tool: when the look needs something the tool lacks, the tool gains it.
- No more than one focal card per beat, and no card text moving while it is meant to be read.
- Nothing is posted. Publishing is a separate ask through `Broadcast` or a social-posting skill.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run by the seam's `render --eval` on the final encode with the project passed as `--composition`, so `type-rendered` reads the type the film was built with, plus the checks Assay compiles from the Ideal State and Anti-criteria above.
  - disabled: duration, voice-identity, voice-wer, voice-pace, script-length, visual-variety, detail, card-corners — each reads a VideoEssay run's `Script.json`, narration timeline, voice records or capture list, which a HyperFrames project does not keep, so on its encode they cannot measure.
  - disabled: watermark-brand, watermark-badge, watermark-zone — a HyperFrames composition draws no channel mark and no DA badge corner; where a mark goes is the film's own direction.
  - disabled: format-4k, encode — the master renders at the composition's own frame (16:9, 9:16, 4:5 or square) through the seam's default encode; the 4K x264 CRF ≤ 12 bar is the VideoEssay YouTube master's.
  - disabled: voice-loudness, voice-true-peak, voice-dead-air, voice-naturalness, script-intent — a SystemFilm is silent by design: it reads with the sound off, so there is no voice to measure and no spoken script to hold to this intent.

## Inputs

- The system and the run: named by the principal, or the work this conversation just did.
- The source data, read fresh: `Skill("Statvs")` Query for what happened, `bun LIFEOS/WORKFLOWS/Workflows.ts show <name>` for a workflow, the ISA for criteria and phases.

## Tool contract

Run from `~/.claude`. `Tools/SystemFilm.help.md` documents the script schema.

```bash
bun skills/HyperFrames/Tools/SystemFilm.ts --script <project>/script.json --dir <project> [--force]
#   writes <project>/index.html and <project>/STORYBOARD.md, stages GSAP; exit 1 on an invalid script, 2 on usage
bun skills/Assay/Tools/Proof.ts plan --brief <project>/BRIEF.md --plan <project>/STORYBOARD.md --kind video --out <project>/proof.json
bun LIFEOS/TOOLS/HyperFrames/HyperFrames.ts snapshot --project <project> --at <t1,t2,…> --out-dir <project>/snapshots
bun skills/HyperFrames/Tools/TextFit.ts --project <still-project> --every 0.5
#   <still-project>: the same script with "camera": "still", built into its own folder; TextFit cannot measure text the camera moves
bun LIFEOS/TOOLS/HyperFrames/HyperFrames.ts render --project <project> --out <project>/Out/<slug>.mp4 --eval skills/HyperFrames/Intents/SystemFilm.md
#   the final encode: the Assay video eval set runs on it; exit 1 on a blocking result, report at <out>.eval/video-eval.json
```

### Intent-to-Flag Mapping

| Ask | Script field |
|-----|--------------|
| "vertical", "for Shorts" | `"size": { "width": 1080, "height": 1920 }` |
| "landscape", "16:9" | `"size": { "width": 1920, "height": 1080 }` |
| "illustrative", "mock data" | `"illustrative": true` |
| "longer", "slower" | `"duration"` up to 40, with event times spread to match |
| "terminal", "like a terminal", "animated terminal" | `"look": "terminal"`, plus `window`, `roles` (each card's `role`) and `prompt` |

## Gotchas

- **Every value that rests on screen is a real span shown by `tl.set`, never text written by `onUpdate`.** Proof's text checks seek the page without firing callbacks, so a counter that only ticked through `onUpdate` rendered as 560 but read as missing (2026-10-22). `onUpdate` drives only the decorative tick between steps.
- **Decorative connector arcs read as broken links.** Both Proof layout judges failed faint arcs that implied connections the system lacks (2026-10-22); the tool draws only `edges`, routes an edge through the gutter when a card sits in its way, and starts signals only once their edge is drawn.
- **Label colour is `text-muted`, never `text-dark`.** `text-dark` on the house slate measures about 3.7:1 and the seam check refuses the render under WCAG AA 4.5:1 (2026-10-22).
- **The film's face is embedded, never a generic stack (2026-10-24).** The proof-loop film asked for `ui-monospace` and shipped in Inter: the compiler prepends Inter to a generic-first stack on the MP4 only, so stills, TextFit, Proof and the critique all saw monospace. The tool now embeds `roleFaces("code")`; Proof's `composition-pixels` check fails a film whose pixels left its stills.
- **A sourced script quotes, never paraphrases (2026-10-24).** The proof-loop log said "24 passed, 0 failed" of a run whose receipt said UNAVAILABLE. Declare `sources` and point every log and outcome line at the line it quotes; the build refuses text the line does not hold.
- **A dashboard that only changes in place never reads as moving (2026-10-25).** Before the camera, every SystemFilm measured 11–17% moving against the eval set's 50% bar, because the motion check ignores small and looping change (signals, tickers, a cursor, a drifting grid), which is right. The camera that follows the events is what passes it (92.6% terminal, 95.8% dashboard), so `camera: "still"` is for proving the layout with TextFit, never for a delivered film. A shot that frames several parts at once grows toward the whole frame and holds the picture still; the tool frames one part per shot.
- **TextFit only measures text at rest, and the camera never rests.** Run TextFit on a `camera: "still"` copy of the script, which keeps the same layout.
- **Signals travel on a seeded PRNG.** Preflight refuses unseeded `Math.random`; the tool seeds from the script's `title`, so the same script renders the same field.

## Output format

The answer opens with the film's path or share link and its length, then the one-line point from `BRIEF.md`, then the source the data came from, then the check results: Proof (plan, stills, final), TextFit, and the critique median or the note that the personal-work exception applied.

## Examples

```
Principal: "make a system film of last night's morning-brief workflow run"
→ BRIEF.md: the run gathered 5 sources, drafted, and stopped at the review gate; source = STATVS rows for that run
→ script.json: phases Collect → Draft → Check → Gate, cards per step, counters from the run's row counts
→ SystemFilm.ts → STORYBOARD.md passes Proof plan → stills pass → 24 s 1080×1350 render
→ critique passes, delivered to Downloads
```
