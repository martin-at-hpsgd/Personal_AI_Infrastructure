# GeneratedContentVideo Intent

End-to-end generated video: a topic or a piece of content becomes a narrated short with AI scene imagery, captions, and motion, composed and rendered on HyperFrames.

## Ideal State

- A `MeaningMap.json` and a `Direction.json` whose review passed exist before any script, image or narration is made, and every scene image and on-screen line traces to a Direction beat's rationale.
- A 60–250 word narration script, `script.txt`, existed before narration was synthesized: written from the MeaningMap (thesis, claims, arc), in the principal's voice (`LIFEOS/USER/PRINCIPAL/WRITINGSTYLE.md`) when it goes out under their name, with one paragraph per Direction beat so each beat owns a span of narration.
- Narration is synthesized, its duration drives the composition's `data-duration`, and captions are timed from the TTS alignment, not estimated.
- Once `Direction.json` has passed review and `script.txt` exists, the scene images and the narration are made side by side, since neither needs the other; the scaffold waits for the narration's probed duration, and assembling the composition waits for both.
- The render went through the seam with `--audio`, so a silent or missing track fails validation.
- The delivery hand-off states that the short has synthetic narration and AI-generated imagery and carries a ready caption line disclosing it, because the seam strips the renderer's metadata and adds no AI-content label of its own.
- The final encode rendered with `render --eval` naming this intent, so the Assay video eval set (`video-eval`) measured it minus the checks `## Evals` switches off with their reasons, and no check failed or went unmeasured.

## Anti-criteria

- No image or narration is generated from a Direction that has not passed review.
- The composition's `data-duration` is never set from the script's word count; it comes from the probed narration length.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run by the seam's `render --eval` on the final encode with the project passed as `--composition`, so `type-rendered` reads the type the film was built with, plus the checks Assay compiles from the Ideal State and Anti-criteria above.
  - disabled: duration, voice-identity, voice-wer, voice-pace, script-length, visual-variety, detail, card-corners — each reads a VideoEssay run's `Script.json`, narration timeline, voice records or capture list, which a HyperFrames project does not keep, so on its encode they cannot measure.
  - disabled: watermark-brand, watermark-badge, watermark-zone — a HyperFrames composition draws no channel mark and no DA badge corner; where a mark goes is the film's own direction.
  - disabled: format-4k, encode — the master renders at the composition's own frame (16:9, 9:16, 4:5 or square) through the seam's default encode; the 4K x264 CRF ≤ 12 bar is the VideoEssay YouTube master's.

## Inputs

Confirm the topic or source, the target platform (vertical 1080x1920 for Shorts/Reels/TikTok, landscape 1920x1080 for YouTube/X), and a length of 30–90 seconds. A DA-narrated explainer of a post, idea or feature for YouTube, at any length, is the video-essay skill's `Explainer` intent where installed; this intent is the generated-imagery short.

- `FISH_API_KEY` (check with `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY`); the DA's Fish voice resolves from `LIFEOS_CONFIG.toml` `[da.voices.main]`.
- The Art skill configured for image generation.

## Tool contract

Extract the source the same way as `ContentToAnimation.md` § Inputs (a bare topic becomes a short written brief in `Source/source.md`). Then:

```bash
VM=~/.claude/LIFEOS/TOOLS/VideoMeaning/VideoMeaning.ts
bun $VM map    --source Source/source.md --out MeaningMap.json
bun $VM direct --map MeaningMap.json --mode essay --out Direction.json --revise 2 --polish
```

One image per insert beat, prompted from that beat's `visual` spec and the theme, at the composition's aspect:

```bash
bun ~/.claude/skills/Art/Tools/Generate.ts --prompt "<beat visual, in the composition's theme palette>" --model nano-banana-pro --aspect-ratio 9:16 --output <project>/assets/scene-<beat>.png --intent-file ~/.claude/skills/HyperFrames/Intents/GeneratedContentVideo.md
```

Generate.ts refuses (exit 1) any call that names no intent; `--intent-file` names this one (verified with `--dry-run`, 2026-10-13).

Run the generations concurrently when there are more than three. Generate.ts may write `.jpg` for a requested `.png`; reference the file it actually wrote.

Synthesize with `fishSpeakWithTimestamps(text, { voice: "main" })` from `LIFEOS/TOOLS/FishTTS.ts`, the one voice client every LifeOS speaker uses, so word-level timings come back with the audio; those timings time the captions and the beat spans, and no second speech-to-text pass is needed for a known script. Save `narration.wav` (or mp3) and `alignment.json` in the project. Probe the real duration with ffprobe; it becomes the root's `data-duration`.

Start from `bun ~/.claude/skills/HyperFrames/Tools/Scaffold.ts --dir <project> --title "<hook line>" --width 1080 --height 1920 --duration <narration s>`, then author:

- `<audio id="narration" src="narration.wav" data-start="0" data-duration="<s>" data-volume="1">`.
- One `<img>` scene clip per insert beat (`class="clip"`, `data-start`/`data-duration` from the beat's narration span), with a slow motivated move (push or drift) rather than a static hold. Use `object-fit: cover` only when the image aspect already matches the frame.
- Captions as clip elements timed from `alignment.json`, a few words per group, tweened on the one paused timeline. Text stays still while it is read.
- Theme variables and eases from `Tools/Theme.ts`. Music only per `References/MusicScore.md`.

```bash
HF=~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts
bun $HF render --project <project> --out <project>/Out/<slug>.mp4 --audio --eval ~/.claude/skills/HyperFrames/Intents/GeneratedContentVideo.md
bun ~/.claude/skills/ArtDirection/Tools/Critique.ts --video <project>/Out/<slug>.mp4 --brief <project>/Brief.json
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact <project>/Out/<slug>.mp4 --to "${LIFEOS_DOWNLOADS_DIR:-$HOME/Downloads}"
```

## Gotchas

- **Image aspect must match the composition.** Generate at 9:16 for vertical and 16:9 for landscape; `cover` hides a mismatch by cropping the subject.
- **Scene images are local project files.** The seam's preflight refuses any remote `src`, and the sandbox blocks the network during render.

## References

`ContentToAnimation.md` animates existing content with typography and diagrams only. This intent also generates the scene images and the narration.
