# ContentToAnimation Intent

Turn a piece of content into a short, themed motion-graphics animation: typography, diagrams, data and quotes animated on HyperFrames. No AI imagery (that is `GeneratedContentVideo.md`).

## Ideal State

- A `MeaningMap.json` and a `Direction.json` exist for the source, the Direction's review passed (both judges, median ≥ 8.5, no critical defect), and every scene in the composition traces to one Direction beat whose rationale names the claim it carries. No scene is decorative or keyword-matched.
- Every on-screen line is held still long enough to read, at ≤ ~4 words per second on screen.
- The final encode rendered with `render --eval` naming this intent, so the Assay video eval set (`video-eval`) measured it minus the checks `## Evals` switches off with their reasons, and no check failed or went unmeasured.

## Anti-criteria

- No AI imagery: scene images and narration are `GeneratedContentVideo.md`.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run by the seam's `render --eval` on the final encode with the project passed as `--composition`, so `type-rendered` reads the type the film was built with, plus the checks Assay compiles from the Ideal State and Anti-criteria above.
  - disabled: duration, voice-identity, voice-wer, voice-pace, script-length, visual-variety, detail, card-corners — each reads a VideoEssay run's `Script.json`, narration timeline, voice records or capture list, which a HyperFrames project does not keep, so on its encode they cannot measure.
  - disabled: watermark-brand, watermark-badge, watermark-zone — a HyperFrames composition draws no channel mark and no DA badge corner; where a mark goes is the film's own direction.
  - disabled: format-4k, encode — the master renders at the composition's own frame (16:9, 9:16, 4:5 or square) through the seam's default encode; the 4K x264 CRF ≤ 12 bar is the VideoEssay YouTube master's.
  - disabled: voice-loudness, voice-true-peak, voice-dead-air, voice-naturalness, script-intent — a ContentToAnimation piece carries no narration (narration is `GeneratedContentVideo.md`), and its cut is often silent, so there is no voice to measure and no spoken script to hold to this intent.

## Output format

Scene timing comes from the content, not a formula: hold each on-screen line for its read (about 3.5 words per second plus a beat per point), give data and quotes more room, and keep every beat between about 2 and 10 seconds.

| Format | Size | Use |
|---|---|---|
| Landscape | 1920x1080 | default, blog and YouTube |
| Vertical | 1080x1920 | Shorts, Reels |
| Square | 1080x1080 | social feeds |

## Inputs

Confirm the source is in hand and the target shape is known (landscape 1920x1080 by default; vertical 1080x1920 for Shorts; square 1080x1080). If either is ambiguous but workable, state the pick in one line (`⚠️ Picking 16:9 because …; redirect if wrong.`) and proceed.

| Input | Extraction |
|---|---|
| YouTube URL | `fabric -y <url>` → transcript |
| Article URL | WebFetch (Research skill if the page resists) |
| `.md` / `.txt` file | read directly |
| PDF | Read tool |
| X/Twitter URL | X blocks WebFetch; use the configured X reader, or ask for the text |
| Raw text | use directly |

Save it in the project as `Source/source.md` (markdown), or as a transcript JSON (`[{start,end,text,speaker?}]`) when timing matters.

## Tool contract

```bash
VM=~/.claude/LIFEOS/TOOLS/VideoMeaning/VideoMeaning.ts
bun $VM map    --source Source/source.md --out MeaningMap.json
bun $VM direct --map MeaningMap.json --mode essay --out Direction.json --revise 2 --polish
bun $VM validate --map MeaningMap.json --direction Direction.json
```

`essay` mode is the standalone-piece mode: every beat is an `insert` or `none`. `direct --revise N` runs the two-vendor review after each round and keeps revising until it passes; exit 1 means no round passed, and `rounds/revisions.json` names the shortfall. Read the Direction before authoring: its `treatment` is the visual through-line, and each insert's `visual` spec and `text` list are what goes on screen, verbatim.

```bash
bun ~/.claude/skills/HyperFrames/Tools/Scaffold.ts --dir <project> --title "<thesis line>" [--subtitle "<…>"] [--width 1920 --height 1080 --fps 30 --duration <s>]
```

The scaffold writes an `index.html` that already meets the seam contract (root data attributes, local GSAP, theme CSS variables, one registered paused timeline) and a title card that renders. Replace and extend its scenes, one per Direction beat:

- One paused GSAP timeline, registered as `window.__timelines[<composition id>]`; timed elements carry `class="clip"` with `data-start`, `data-duration`, `data-track-index`.
- Colours, type scale, spacing and eases come from the theme variables and `LIFEOS_THEME.motion` (`Tools/Theme.ts`).
- Everything local: images, fonts (through the seam's `embedFonts()`/`injectFonts()` + `registerAfterFonts()`), audio. Generic font families need no embedding; any named family does.
- The composition rules that bite are in the seam README § Gotchas (no CSS transitions, no wall-clock or random APIs, no negative z-index clips). HyperFrames' own authoring docs: https://hyperframes.heygen.com.

```bash
HF=~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts
bun $HF check    --project <project>
bun $HF snapshot --project <project> --at 1,4,8 --out-dir <project>/Stills     # look at these before a full render
bun $HF render   --project <project> --out <project>/Out/<slug>.mp4 [--audio] --eval ~/.claude/skills/HyperFrames/Intents/ContentToAnimation.md   # the eval set on the final encode; exit 1 on a blocking result
```

A render that fails a seam stage throws with the stage and findings.

```bash
AD=~/.claude/skills/ArtDirection/Tools
bun $AD/Critique.ts --video <project>/Out/<slug>.mp4 --brief <project>/Brief.json   # writes Out/Critique.json
bun $AD/Deliver.ts  --artifact <project>/Out/<slug>.mp4 --to "${LIFEOS_DOWNLOADS_DIR:-$HOME/Downloads}"
```

Write `Brief.json` from `skills/ArtDirection/References/BriefExample.json` with the Direction's treatment as the intent. Deliver refuses without a passing critique whose artifact mtime matches.
