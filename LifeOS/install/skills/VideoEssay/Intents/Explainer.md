# Explainer

Any source (a blog post, an idea, a feature, a page) plus a length becomes a short explainer video narrated by the DA, built on this skill's Script and Produce pipeline, and, when the ask includes YouTube, handed to `Video` for the thumbnail, the full description and a private upload.

## Ideal State

- The length the user gave is the length delivered: `Script.json` `targetMinutes` is that length, and the rendered `Out/essay.mp4` runs within ±15% of it (the DA voice at `fish_speed` 1.25 runs about 3.2 words a second with chapter holds, so two minutes is roughly 370–400 words of narration; the 2026-10-24 cut ran 406 words in 2:06). With no length given, the pick (90 s for an idea or feature, 2–3 min for a post) is stated in one line and the run proceeds.
- `Essay.md` exists with `kind: explainer`, `title`, `thesis` (one paragraph that could open the YouTube description), `source`, and one section, `## The Argument`, the narration; `bun Tools/EssayLint.ts --run <slug>` exits 0 on it.
- The narration covers the source, not a slice of it: every major claim or section of the source has a beat, in the source's order, so a viewer who never reads it comes away with its whole argument; a post's own examples, metaphors and diagrams carry the explanation where the post has them.
- The narration is first person as the DA explaining the author's work ("{{PRINCIPAL_NAME}} argues…" in the author's terms, never the DA claiming the author's view as its own), says once that an AI is narrating, invents no position the source does not take, and treats anyone the source disagrees with as fairly as the source does.
- Every visual is directed from meaning, as in `Intents/Script.md`: `Meaning.ts` ran and its review passed before `Script.json` was written, a post's own images and page appear as `screenshot` or `scroll` beats where they carry the point, and the beat count fits the length (about one beat per 8–15 s), with ScriptLint passing; `--require-classes` names only the classes the source actually supports, said in the report.
- Production meets every Ideal State bullet in `Intents/Produce.md`: the DA's configured Fish voice with word timings, the presence layer, `Out/verify.json` all green, the review sheets read, and the mp4 delivered through `Deliver.ts` after a passing critique and Proof.
- The description carries `EXPLAINER_DISCLOSURE` and "Explaining: <source>" (`Describe.ts`), never the essay's "Responding to".
- When the ask includes YouTube, three more outputs exist before upload, each from `Video`: a thumbnail in the DA house style (the `Video` skill's ThumbnailStyles reference, § The DA Style: the narrator decides the style, so never SOLO), rendered by `Tools/Thumbnail.ts` with the post's own header image as its background plate (`Script.json` `thumbnail.background`, or a generated plate per the `Video` ThumbnailBackground intent only when the source has no header image), the title reading on the 320 px proof, delivered as the ≤ 2 MB q85 JPEG; a full description from the `Video` YouTubeDescription intent in the channel's `DescriptionFormat.md`, solo first-person, with tracked links, the related-content block from the corpus search, the explainer disclosure line, and every URL probed 2xx/3xx; and the upload itself, PRIVATE, with thumbnail, description and tags attached, the watch page read back, and the private URL reported.
- When the ask is to add the video to a post (`pv`), the YouTube leg runs as above, then the video is set UNLISTED through `Video` (`YouTubeUpload.ts publish --privacy unlisted --no-promote`), the post gets `<YTVideo>https://www.youtube.com/watch?v=<id></YTVideo>` on its own line under its header image through the blog skill, the blog ships through its gated deploy from a clean tree, and the live post shows the embed playing in a real browser; the watch URL and the live post URL are reported.
- The render passed the Assay video eval set (`video-eval`) as `Intents/Produce.md` states it, and the report gives its verdict, its failing or flagged checks and the receipt path.

## Anti-criteria

- No argued essay sections (`Their Claims`, `Where We Agree`, `The Disagreement`) are invented for an explainer, and an explainer never turns into a response or rebuttal; a stance to argue is `Intents/Full.md`.
- Never reads the post verbatim to fill the length; a word-for-word read of the author's post is `Intents/Voice.md`.
- Never exceeds the requested length to fit more in, and never pads to reach it.
- Nothing is published public, and nothing is unlisted except a video the user asked to add to a post (`pv`), which an embed needs: the upload is private, and any other flip is the user's separate call through `Video`.
- No generated thumbnail plate when the source post has a header image, and no SOLO thumbnail with the principal's face on a video the DA narrates.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run by `Run.ts`'s `eval` stage on every render, plus the checks Assay compiles from the Ideal State and Anti-criteria above.

## Inputs

- The source: a post (`.md` path or URL), a URL, a file, or the idea or feature in the user's words (saved verbatim as `Source/notes.md`). "Our latest blog post" resolves to the newest published post in the blog project named in `LIFEOS/USER/PROJECTS.md`, read in full from its source file.
- The length, and whether the ask includes YouTube.

## Tool contract

```bash
bun ~/.claude/skills/VideoEssay/Tools/Intake.ts --run <slug> --file <post.md>    # or --url <url>; an idea: --file Source/notes.md
bun ~/.claude/skills/VideoEssay/Tools/EssayLint.ts --run <slug>                  # kind: explainer; no --source (there are no opposing quotes)
bun ~/.claude/skills/VideoEssay/Tools/Meaning.ts --run <slug>                    # before Script.json
bun ~/.claude/skills/VideoEssay/Tools/ScriptLint.ts --run <slug> --require-classes <the classes the source supports>
bun ~/.claude/skills/VideoEssay/Tools/Run.ts --run <slug>                        # Produce, in the background
bun ~/.claude/skills/VideoEssay/Tools/Thumbnail.ts --run <slug> --bg <post header image>   # or Script.json thumbnail.background; Run.ts's thumbnail stage reads the same field
```

Then `Intents/Produce.md` § Tool contract for the critique, Proof and `Deliver.ts`. The YouTube leg runs the `Video` intents named in Ideal State; the upload command and its read-back are in the `Video` ExportReliably intent and `SKILL.md` § Review state, and this skill makes no upload call itself.

## Output format

The final message opens with the private watch URL (or the Downloads path when there was no YouTube leg) and the delivered length against the target, then the thesis in one line, the verify summary (checks green, WER, loudness), the eval set verdict with its flags, the critique median, the thumbnail and description paths, and every open item: pronunciation by ear, PII findings, the public flip.

## Examples

```
User: "make a 2-minute explainer of our latest blog post and upload it private to YouTube"
→ newest post read in full; Essay.md (kind: explainer, ~300 words, every section of the post covered)
→ Meaning → Script.json (targetMinutes 2, the post's diagrams as screenshot beats) → Run.ts → verify green, critique passed, delivered
→ thumbnail on the post's header image, full description, private upload read back; private URL reported
```
