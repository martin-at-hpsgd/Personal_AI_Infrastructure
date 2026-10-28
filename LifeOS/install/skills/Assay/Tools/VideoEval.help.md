# VideoEval.ts — the video eval set

One command measures a rendered video against every dimension the principal named on 2026-10-24 (watermark, voice, script, typography, animation quantity, animation quality) plus format, encode, duration and PII. It writes one assay receipt bound to the video's sha256, cheapest tier first. Every judge it runs goes through Assay's transports: VisionJudge (OpenAI + Anthropic panel), VideoJudge (audio and video), and Proof's judgment layer.

## Commands

```bash
bun skills/Assay/Tools/VideoEval.ts run --run <slug|dir>            # a VideoEssay run: Out/essay.mp4 plus its script, timeline and intent
bun skills/Assay/Tools/VideoEval.ts run --video <file.mp4>          # any rendered video; a file in a run's Out/ joins that run
bun skills/Assay/Tools/VideoEval.ts run --video <file.mp4> --intent <intent.md> [--narration <file.txt>]   # a bare video against its intent
bun skills/Assay/Tools/VideoEval.ts run --video <film.mp4> --intent <HyperFrames intent> --composition <project dir>   # a HyperFrames film, its type read from the project
bun skills/Assay/Tools/VideoEval.ts run --video <file.mp4> --intent <intent.md> --fresh   # no memo and no stored result: every check re-measures the bytes
bun skills/Assay/Tools/VideoEval.ts run --run <slug> --check motion-share,card-corners   # re-run checks alone (no receipt)
bun skills/Assay/Tools/VideoEval.ts list                            # every check id, tier, dimension and bar
```

- `--judges auto` (the default) runs the judged checks only when every code check passed; after a code failure they are `not-run`, with no finding. `always` runs them anyway, for a report. `never` records every judged check as unavailable (a finding at tier judge plus a `judges-off` opt-out), so the verdict reads unavailable and the exit is 2, never 0.
- `--intent <file>` names the intent the video was made for. Inside a VideoEssay run the intent is the run's own (`Essay.md` `kind:` explainer → `skills/VideoEssay/Intents/Explainer.md`, a voice run → `Voice.md`, else `Full.md`), and `--intent` naming another is refused with exit 2. The intent's `## Evals` switch-offs (`  - disabled: <id>, <id> — <reason>`) are applied, and each one is written to the receipt's `opt_outs` as `intent-switch-off` with `<intent path>: <reason>`. `check_set.version` is always the sha over the full set.
- `--narration <file>` gives a bare video's narration text to `script-intent`; without it, the check reads the video's whisper (`base.en`) transcript.
- `--destination handoff|send|publish|deploy|isa-close|none` is the receipt's destination class (default `handoff`).
- `--composition <dir>` names the HyperFrames project the film was rendered from; `type-rendered` opens its `index.html` the same way it opens a VideoEssay stage. The seam's `render --eval` passes it, so HyperFrames intents no longer switch `type-rendered` off. It is accepted only when the newest render row for these bytes names that project and the project still hashes to the digest the row recorded; otherwise the run is refused (`ProvenanceRefused`, exit 2) before anything is measured. A project file newer than the video means the project is not the one the film came from, and the check is unavailable.
- `--no-memo` skips the memo but still takes Verify's results when `Out/verify.json` binds these bytes. `--fresh` (`runVideoEval({ fresh: true })`) reads no memo, writes none, and uses no stored result of any kind (`Out/verify.json`, Verify's `Out/pii.json`): every check re-measures the bytes, and the receipt's profile says `mode:fresh`. `--json` prints the report.

## Provenance: which pipeline made these bytes

Provenance is read from the record, never guessed (`LIFEOS/TOOLS/lib/RenderProvenance.ts`). Every producer writes one STATVS `render` row for its final file's sha256 the moment it writes it: VideoEssay `Run.ts` when its build stage passes (pipeline `VideoEssay`, the run's intent), the HyperFrames seam for every validated encode (`HyperFrames`, the intent, the project dir and a digest of its files), StoryFilm `Build.ts` (`StoryFilm`, `Produce.md`, its composition), and, where the video pipeline skill is installed, its compositor `Compose.ts` (the camera-footage pipeline, an optional `--intent`). A compositor output whose primary input is another pipeline's render, or that carries a VideoEssay or StoryFilm render anywhere, gets no camera row.

Under an intent, VideoEval admits only bytes whose newest render row names that intent's pipeline (`skills/<Pipeline>/Intents/*.md`). Bytes with no row (a remux, a crop, a covered badge, a re-encode) are refused under every intent with `ProvenanceRefused` (exit 2), naming the tool to re-run, and no receipt is written. An intent that lives outside the Intents folder of one of those pipelines (`skills/<VideoEssay|HyperFrames|StoryFilm>/Intents/`, plus the video pipeline skill's own where it is installed) is refused too. With no intent, a bare report still runs. The badge below stays a second, independent signal.

## Origin and the switch-off allowlist

Origin is read from the pixels, never a path. `badgeOrigin(video)` matches the watermark-badge template (the DA avatar disc) at the badge corner on 12 evenly spread frames, cropped from a 1080p scale of each; `ncc` is the median frame score and `present` is `ncc ≥ 0.8`. It runs fresh on every eval, before any check, in about a second on a 4K essay. Bytes that wear the badge are evaluated only under `skills/VideoEssay/Intents/Full.md` or `Explainer.md` (the real files in this install; a copy elsewhere does not count). Any other intent, a camera intent such as the video pipeline skill's ExportReliably included, is refused with `IntentOriginMismatch` (exit 2) and no receipt, so a remux or rename of a DA essay cannot borrow a camera intent's switch-offs. When the badge cannot be looked for (no avatar, an undecodable file), every intent but Full and Explainer is refused.

The receipt carries `origin: { badge_ncc, badge_present }` (null when unmeasured). Gates never trust it: they call `badgeOrigin` on the bytes they are about to admit.

Some checks are protected: `duration`, `voice-identity`, `voice-wer`, `voice-pace`, `script-length`, `script-intent`, `visual-variety`, `detail`, `card-corners`, `watermark-brand`, `watermark-badge`, `watermark-zone`, `type-rendered`, `motion-share`, `motion-max-still`, `visual-cadence`. An intent switches one off only when its pipeline's allowlist names it (`switchOffProblems`); otherwise the run is refused with `SwitchOffRefused` (exit 2) before anything is measured.

| Pipeline | Protected checks it may switch off |
|---|---|
| VideoEssay Full, Explainer (and Produce, Script, Argue) | none |
| VideoEssay Voice | `watermark-badge`, `watermark-zone`, `voice-identity`, `voice-pace`, `motion-share`, `motion-max-still`, `visual-variety` (`visual-cadence` still blocks) |
| HyperFrames, StoryFilm | the checks that need a VideoEssay run (`duration`, `voice-identity`, `voice-wer`, `voice-pace`, `script-length`, `visual-variety`, `detail`, `card-corners`, `watermark-brand`, `watermark-badge`, `watermark-zone`); `script-intent` only when the intent also switches off `voice-loudness`, `voice-dead-air` and `voice-naturalness` (no narration); `type-rendered` only when no `--composition` is given; never the motion checks |
| Camera-footage intents (the video pipeline skill, where installed) | what they declare, on bytes with no essay badge (origin refuses the rest) |
| any other intent | none |

Unprotected checks (`format-4k`, `encode`, loudness, true peak, dead air, `type-config`, PII and the judges) stay each intent's own call, with its reason on the receipt.

Output: one line per check with its time and whether the memo served it, then the verdict and the code-tier, judged and total times. A full run writes the receipt (`MEMORY/STATE/Proof/receipts/`) and `Out/eval/video-eval.json` (for a bare video, `<video>.eval/video-eval.json`). A `--check` run writes `video-eval.partial.json` and no receipt, because a subset must never stand in for the whole set's verdict.

## The checks

| Id | Tier | Bar |
|---|---|---|
| `format-4k` | code | h264 3840x2160 (30 fps on a VideoEssay run), aac audio |
| `encode` | code | x264 CRF ≤ 12 (Verify `encodeVerdict`) |
| `duration` | code | container = narration timeline ± 0.5 s |
| `watermark-brand` | code | Config.json `cornerLogo` (its alpha) bottom-left at 32/32/72 px, NCC ≥ 0.8 on all 12 sampled frames |
| `watermark-badge` | code | the DA avatar disc bottom-right (essay badge), NCC ≥ 0.8 on all 12 sampled frames |
| `watermark-zone` | code | YouTube's bottom-right zone (x ≥ 1640, y ≥ 800 at 1080p) holds nothing but the badge and its tie: ≤ 0.2% of other pixels off the ground |
| `voice-identity` | code | every chunk's `<chunk>.voice.json` (written by Narrate.ts at synthesis) names `[da.voices.main]`'s `fish_reference_id` and `fish_speed`; a chunk with no record passes only when its file name `<id>.<hash>.wav` carries Narrate's `chunkHash` of the beat's spoken text in today's `daVoice()` (voice id, model, speed), fails on another hash, and is unavailable when the text cannot be rebuilt. The hash binds the voice id, not the Fish reference behind it |
| `voice-wer` | code | whisper WER ≤ 8% (Verify `speech`; Verify's own result when `Out/verify.json` measured these bytes) |
| `voice-loudness` | code | −16 ± 2 LUFS essay, −14 ± 1 LUFS voice (Verify `loudnessCheck`) |
| `voice-true-peak` | code | ≤ −0.5 dBTP |
| `voice-pace` | code | median words/s within ±12% of 2.82 × fish_speed; every 12+-word beat within ±30% of the median |
| `voice-dead-air` | code | no silence over 1.5 s (−40 dB) between the first and last narrated word |
| `script-length` | code | rendered length within ±15% of `targetMinutes` |
| `type-config` | code | every house type role in its face and case in the configuration (TypeRoles.json); no house system is unavailable |
| `type-rendered` | code | the built composition the video came from (the stage dir `Out/render.json` names) opened in the seam's headless Chrome: every text node in an embedded face that a TypeRoles.json role holds, at that face's weight, in its role's case (upper, title); no block all lowercase; pre/code keep their literal case. On a HyperFrames film, `--composition <project dir>` names the project instead. Unavailable on a bare video with no `--composition`, when the stage or project changed after the render, or in a shell where the seam's macOS sandbox cannot start |
| `motion-share` | code | moving ≥ 50% of the time: 4 fps, 480x270 gray, badge column (x ≥ 1560/1920) cut; a pair moves when its content differs by ≥ 0.05 luma levels after the frames are aligned. Slow camera drift (a Ken Burns move of ≤ 2 px of 480 and ≤ 1% zoom per sample, with the aligned frames matching block by block) and global brightness or contrast changes (a gain and offset solved with the alignment and dropped) are excluded |
| `motion-max-still` | code | no still stretch over 4 s; drift and lighting changes over a held picture count as still |
| `visual-cadence` | code | a change at least every 8 s of narration: a frame that differs from the last change frame by ≥ 1.5 levels after that frame is aligned to it (or keeps under half of it in view), so drift and brightness changes never add up to a change |
| `visual-variety` | code | ≤ 2 consecutive beats of one visual type |
| `detail` | code | each shown image keeps ≥ 85% of its source's edge detail (Verify `detail`) |
| `card-corners` | code | every visible corner of every capture card ≥ 16 px at 1080p, measured on the beat's midpoint frame; a capture beat with no measurable card is unavailable (named), an essay run with no capture beats is unavailable; a too-square card fails either way |
| `voice-naturalness` | judge | the audio judge (VideoJudge, audio/mp4) scores ≥ 4 of 5 |
| `script-intent` | glance | `Proof.ts run --intent <intent>` on the narration (Script.json; on a bare video `--narration` or the whisper transcript); its intent findings join this receipt as `script-intent/<id>` |
| `visual-judge-sharpness` | judge | VisionJudge panel on four native-pixel crops, ≥ 4 of 5 from both vendors |
| `visual-judge-meaning` | judge | the same panel on the motion strip (a row per beat, six frames through it; on a bare video one frame every 4 s, rows of six) |
| `visual-judge-variety` | judge | the same panel on the contact sheet (one frame per beat; bare: one every 4 s, at most 60) |
| `visual-judge-polish` | judge | the same panel on four full frames of capture beats (bare: four evenly spaced frames) |
| `visual-judge-typography` | judge | the same panel on four full frames of text beats (bare: four evenly spaced frames): hierarchy, size, legibility, casing, line breaks |
| `pii` | judge | VideoPiiGate finds nothing; findings are flags for review (Verify's `Out/pii.json` when Verify measured these bytes, so the upload runs once) |

Every judged rubric anchors levels 1, 3 and 5. A judged "no" is a flag until `LabelStore.earnedStatus({check_id: "<id>"})` reads earned; then it is an earned fail. The key is the check id, the one the label join writes, so a principal verdict joined to a receipt (`deriveJoinedLabels`) counts here. The receipt's `profile` lists every check that made its own call as a bare id (`profileRan`), so the join sees passes as well as failures. The memo stores the judge's raw answer (ok, detail, models, scores) and earning is applied on every read, so a question that earns blocks on a memo hit too. Each judged check's version covers the judge transports (VisionJudge.ts, JudgeCall.ts, VideoJudge.ts) and the panel's resolved model ids.

On a bare video (no run dir) the visual judges sample their evidence evenly from the video itself, so they run on any render, not only a VideoEssay one.

## Memo and speed

Each check names the inputs it reads (the video stream's packet hash, the audio stream's packet hash, the script, the timeline, the logo, the avatar, the voice config and records, the assets, the intent) and the code files that define it. Its finding is stored under the sha256 of those hashes and its own source (`MEMORY/STATE/Proof/video-eval-memo/`; `LIFEOS_VIDEO_EVAL_MEMO` overrides it). An unchanged check returns its stored finding without measuring or calling a model. Changing the narration re-runs the audio checks and leaves the visual ones in the memo. An unavailable result is never stored.

Verify writes the video's and Script.json's sha256 into `Out/verify.json`. When they match, `format-4k`, `encode`, `voice-wer`, `detail` and `pii` take Verify's results instead of measuring again, so a VideoEssay pipeline render runs whisper and the PII upload once. `--fresh` turns this off with the memo.

On the 2026-10-24 two-minute 4K cut (models-how-harnesses-what), measured 2026-10-25 after the review fixes: a cold code tier ran in 25–35 s, mostly whisper; a cold full set with judges in 55 s; a no-op re-run in 0.4 s; and the eval stage right after a Verify of the same bytes in 4.3 s.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | no blocking finding (unearned flags allowed) |
| 1 | a code fail, or an earned judged no |
| 2 | a check could not be measured (judges off included); or a refusal, with no receipt: `--intent` is not the run's own (`IntentMismatch`), the bytes wear the DA essay badge under an intent that is not VideoEssay Full or Explainer (`IntentOriginMismatch`), or the intent switches off a protected check its pipeline may not (`SwitchOffRefused`) |
| 64 | usage |
