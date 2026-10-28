# VideoMeaning — the meaning layer for video

The `VideoEssay` and `Video` consumers are optional and are NOT in the public release payload. VideoMeaning's commands work without those consumers.

Decomposes a piece of content into a **MeaningMap**, directs every beat of the video from it as a **Direction**, and reviews that plan with two judges on two vendors before anything renders. It is engine-agnostic: nothing here imports a renderer. `VideoEssay` (voice and essay modes) and `Video` (Enhance/Augment overlays) consume the Direction.


## Commands

```bash
bun VideoMeaning.ts map      --source <post.json|transcript.json|file.md> --out MeaningMap.json
bun VideoMeaning.ts direct   --map MeaningMap.json --mode voice|essay|overlay [--timeline timeline.json] [--faces faces.json] --out Direction.json [--revise N [--polish]]
bun VideoMeaning.ts review   --map MeaningMap.json --direction Direction.json [--timeline …] [--faces …] --out review.json
bun VideoMeaning.ts revise   --map MeaningMap.json --direction Direction.json --rounds N [--polish] [--review review.json] [--timeline …] [--faces …] --out Direction.json
bun VideoMeaning.ts validate --map MeaningMap.json [--direction Direction.json] [--faces faces.json]
```

Overlay runs add `--demos demos.json` to direct, review and revise.

`--level`, `--vendor` and `--timeout` mirror `Inference.ts` and set the author lane for map, direct and revise. The default is Anthropic `high` (Opus), the workhorse. The judges are fixed: Anthropic `max` (Fable) and OpenAI `max`, with vendor fallback off so they stay on two vendors. `--source` overrides the source path the map recorded. `--polish` (with a review loop) runs one more revision after a pass against the defects the passing review still names, and keeps it only when its own review still passes.

Exit codes: 0 done (review: pass), 1 failed (review: fail, or no valid plan), 2 usage or input error.

## Files

- **MeaningMap.json**: thesis; claims (`c1…`: statement, support, `madeIn` units, speaker); units (`u1…`) that partition the source in order, each with a role (setup, claim, evidence, example, turn, payoff, aside, list), the claim it `serves`, a `takeaway`, and a verbatim `keyLine`; the emotional `arc`; `terms`; `speakers`. Post units anchor to `post.json` paragraph ids; transcript units anchor to time spans in seconds.
- **Direction.json**: `treatment` (the visual through-line) and beats (`d1…`) that cover every unit in order. Each beat has an `intent`, a `choice` (voice: page | insert; essay: insert | none; overlay: speaker | insert), a `visual` spec when it is an insert, a `placement` rect for overlays, a `span` in seconds when timing is known, and a `rationale` (`carries` claim or unit ids, optional `move`, `why`).
- **review.json**: `verdict`, `median`, `bar` (8.5), `reasons` for a fail, `notes`, each judge's score and executed model, and every defect ranked by severity. Lint defects (`source: "lint"`) come from deterministic checks.
- **rounds/**: with `--revise` or `revise`, every round's direction and review, plus `revisions.json` with the shortfall when nothing passed; with `--polish`, `polish.direction.json`, `polish.review.json` and a `polish` record (kept or not, and why).
- **Concept inserts** carry `text`, every on-screen string verbatim (the lint checks this list, not quotes parsed from prose), and an optional `fallback`: the points/compare/stat/quote/diagram form a renderer without bespoke animation draws instead, showing only strings from `text`. No fallback means the concept is unrenderable until a renderer can build it.
- **demos.json** (overlay input, `--demos` on direct/review/revise): `{ demos: [{ start, end, what? }] }`, stretches where the thing is already on screen. The director is told them, and the lint fails an insert on one (critical `over-live-demo`).
- **faces.json** (overlay input): `{ faces: [{ x, y, w, h, start?, end?, speaker? }] }` in fractions of the frame. A face without start and end holds for the whole video.

## What the validator refuses

- An insert whose rationale names no existing claim or unit.
- An insert over the opening unit in voice mode (the author's page opens the piece).
- Two inserts in consecutive beats in voice mode.
- An overlay insert whose placement opts into `keepClear` and overlaps a guarded face during its span. The face refusal is opt-in per placement: a content inset sits centered at 66% and covers the face by design (the Video rule of 2026-08-23), so a placement guards faces only when it says `keepClear: true` (every face) or `keepClear: [speaker ids]` (a 2-up pane replacement keeps the talking person clear). With no placement, the insert is the centered inset.
- Beats that skip, reorder or repeat units; a choice the mode does not allow; a visual that breaks its field contract; X/Twitter URLs.

## What the lint flags in review

On a speaker-labelled transcript (overlay.ts): words on a card that are another speaker's (critical `wrong-speaker`), quoted on-card text that is not the speaker's exact words (critical `not-verbatim`), a cut-down line that adds or rewords (major), an attribution naming no speaker (critical). A card's speaker is its quote's attribution, else the speakers of the claims it carries, else of its units. Also: decorative rationales (critical), numbers not in the source (critical), insert text that is not the author's words or a cut-down of them (major), capture URLs the source does not name (major), inserts starting less than 30 s apart in voice and overlay modes (major), and labels using words the source never says (minor).

## Verdict

A plan passes only when both judges answered, no defect is critical, and the median score is at least 8.5. A judge that ran below its requested rung is recorded in `notes`.

## Speakers (overlay.ts)

A speaker-labelled transcript is one where every block names its speaker. On one, the map pass also requires every claim and unit to name its speaker, from the transcript's own ids. Three more failures send the map back for repair: a claim given to someone who says nothing in its units, a unit given to someone silent in its span, and a unit keyLine that is not its speaker's own words. `Video`'s `skills/_VIDEO/Tools/CardMap.ts` (not in the public release) runs the same attribution check as a hard refusal before any card is rendered.
