# Tools and run layout

Every stage tool's command line and contract, the directory a run writes, and where the composition code lives. `Tools/Run.ts` drives the stages in order; read this when running or debugging one stage directly, choosing a flag, or finding a run's files.

## Run layout

```
<run>/
  run.json  Source/{transcript.txt,source.json,notes.md}
  Essay.md  Script.json  Plan.json (voice: compiled by the meaning stage, or hand-written)  pronunciations.json (optional, TTS-only respellings)
  Meaning/{MeaningMap,Direction,review,compile,Direction.rendered,plan.provenance,stamp}.json  rounds/  (essay: argument.md, Visuals.json)
  Score.json (optional, music as code)
  Narration/<beat>.<hash>.{mp3,wav,align.json}  narration.wav  timeline.json  score.wav  bed.wav
  Assets/<beat>.png  <beat>.meta.json  <beat>.region.json
  Out/essay.mp4  thumbnail.png  thumbnail-320.png  description.md  verify.json  pii.json  frames/  review/
```

## Tool contracts

| Tool | Contract |
|------|----------|
| `Tools/Intake.ts --run <slug> --youtube <url> \| --url <url> \| --file <path> [--notes f]` | creates the run, pulls the transcript (fabric for YouTube) |
| `Tools/EssayLint.ts --run <slug> --source` | frontmatter, sections, every quote verbatim in the transcript, attribution discipline |
| `Tools/ScriptLint.ts --run <slug> [--require-classes motion,screenshot,scroll,zoom,code]` | schema + runtime + class coverage |
| `Tools/Narrate.ts --run <slug> [--force] [--verify]` | per-beat Fish Audio speech with word timings (`LIFEOS/TOOLS/FishTTS.ts`, key `FISH_API_KEY`), split at `FISH_CHUNK_LIMIT`, hash-cached, joined with a fixed gap, loudness-locked, `timeline.json` |
| `Tools/Score.ts --run <slug> [--preset ambient\|pulse] [--force] [--verify]` | `Score.json` → synthesized `score.wav` → sidechain-ducked `bed.wav`; no-op without a score; `--verify` checks bed length and the duck depth |
| `Tools/Capture.ts --run <slug> [--force] [--verify] [--only <beat>]` | Interceptor test-context captures + DOM regions |
| `Tools/Build.ts --run <slug> [--captions]` | stages public/runs/<slug>, composes it as a HyperFrames project (`Compose.ts`) and renders through the shared seam |
| `Tools/Verify.ts --run <slug> [--check name]` | reads the render back; writes `Out/verify.json`; `--check sheet` writes the `Out/review/` studio pass |
| `Tools/Thumbnail.ts --run <slug> [--verify]` | HyperFrames snapshot through the seam, border-sampled |
| `Tools/Describe.ts --run <slug> [--verify]` | description with chapters |
| `Tools/Run.ts --run <slug> [--from stage] [--to stage] [--force] [--music ambient\|pulse] [--accept-review-shortfall] [--polish]` | essay: lint, then narrate → score beside capture, then build, then verify beside thumbnail, then describe once verify passes (other stages wait only for what they read); after any failure no stage starts; voice: clean → align → plan → meaning → lint → capture → build → verify → describe |
| `Tools/DesignAudit.ts [--run <slug>] --check <fonts,layout,center,fill,safe,collide,empty,legibility,sync,camera,seam,types,style-doc,config,git-fonts> [--scope badge] [--json]` | measures a composed run in the pinned headless browser against the design system (`References/Style.md`). Never renders; exits 1 on any violation |
| `Tools/Setup.ts [--check]` | one-time: deps, fonts from the user config, the pinned HyperFrames CLI and browser, avatar cutout |
| `Tools/Ingest.ts --run <slug> --post <md\|url> (--audio <file> \| --narrator clone\|da \| --clone) [--label <NAME>] [--capture-url <url>]` | voice mode: `Source/post.json` (paragraphs, links), and the recording copied byte-identical with provenance or one synthesized take of the whole post (split at paragraph boundaries only past the model limit); narrators per `Intents/Voice.md`. Clean, Align, PlanBeats and Verify treat `da` exactly like `clone` (no TightCut; WER against the post's words). `--label` sets this run's badge author (run.json `label`, over the configured label); `--capture-url` is where Capture loads a post that is not live yet (run.json `captureUrl`: https, or http on localhost, e.g. a local draft server), while the video and description keep the post's own URL |
| `Tools/Clean.ts --run <slug>` | voice mode: the recording through `Video` TightCut; exits 3 while a cut touching a negation, number, or correction is unruled |
| `Tools/Align.ts --run <slug> [--verify]` | voice mode: whisper word times on the final audio, each word mapped to its paragraph and position in the post |
| `Tools/PlanBeats.ts --run <slug>` | voice mode: words + post + `Plan.json` → `Script.json` and a gapless `timeline.json` |
| `Tools/Meaning.ts --run <slug> [--force] [--accept-review-shortfall] [--polish]` | voice: direct and review the inserts against the timeline (`--revise 2`) and compile the passing Direction into `Plan.json` (`Intents/Voice.md`); essay: write `Meaning/Visuals.json`, which ScriptLint holds `Script.json` to (`Intents/Script.md`). A failed review exits 1 with its defects |

The composition is plain TypeScript in `Tools/`: `Page.ts` (the page entry), `PageVisuals.ts` (beats, captures, the read camera), `PagePresence.ts` (essay presence and the voice badges), `DiagramLayout.ts` (graph-shape diagram layout), `ReadCamera.ts` (the reading camera Verify replays), `Motion.ts` (springs and easing). `Compose.ts` turns a staged run into a HyperFrames project and renders it through `LIFEOS/TOOLS/HyperFrames`. `Tools/public/` and `Tools/node_modules/` are gitignored. Script shape: `References/ScriptSchema.md`. Score shape: the header of `Tools/Score.ts`. House style constants: `References/Style.md`.
