---
name: ArtDirection
version: 1.1.4
metadata:
  short-description: "Runs the quality loop for artistic work: a direction council, a two-vendor critique against an anchored rubric, iteration to the bar, and gated delivery."
evals:
  deterministic:
    - command: "bun LIFEOS/TOOLS/SkillHygieneGate.ts --skill ArtDirection"
      falsifier: "the skill body carries a deny-list token or a home-path literal"
  manual:
    reason: "whether the panel's verdict tracks what actually reads as professional to the principal needs the principal's own eye"
    falsifier: "the reviewer finds a delivered artifact that reads as amateur despite a passing Critique.json, or a Critique.json fail on something that is actually excellent"
description: "Directs visual quality across images, films, slides, and site captures through a direction council, two vendors' vision judgments against anchored craft criteria, ranked defects, bounded iteration, gated delivery, and recorded human calibration labels. USE WHEN critique this, art direction, quality loop, rate the visuals, is this pro, iterate until it's great, deliver the render, art council. NOT FOR producing the artifact itself (use the appropriate image, motion, story-film, video-essay, web-design, or slide-production capability), for text writing audits, or for rating and rendering an ISA (ISA)."
---

# ArtDirection

A shared quality loop for artistic deliverables: the Brief defines audience, register, references and bar; a Direction council resolves the visual intent into `Direction.md`; the domain skill produces the artifact against it; Critique yields two vendors' scores and ranked defects; iteration reaches the bar or reports the shortfall at four rounds; only a passing result reaches Deliver; and Calibrate records the principal's own verdict as evidence for later judge calibration. The domain skill makes the artifact; this skill supplies the quality evidence.

## Ideal State

- Nothing artistic reaches the principal or a public surface without a current passing critique from the judge panel bound to the exact bytes delivered. The panel is cross-vendor whenever two approved vendors are reachable; a one-vendor panel may still pass, and its report carries the `vendor_missing` flag as weaker evidence.
- Every verdict is honest: pass only when the pooled median reaches the bar and each vendor median reaches bar minus 0.5, with no UNKNOWN score or critical defect, a cap hit reported with its shortfall, and an unreachable vendor reported as unavailable rather than as a quality failure.
- Each round names ranked, located defects a producer can fix, judged against the concept-first rubric rather than adjectives.
- A figure's anatomy and mechanics are judged as a defect class: extra or missing limbs, a grip or pose that does not match the object held, or physically impossible motion is a critical defect located by image region or frame, so the critique fails it; the judges read this rule from `References/Rubric.md`.
- The principal's own scores are kept verbatim as labels, and judges change only through a deliberate calibration, never automatically.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Loop** | Full quality loop or iterate to the bar | `Intents/Loop.md` |
| **Direction** | Art council or new visual direction | `Intents/Direction.md` |
| **Critique** | Rate the visuals or inspect a render | `Intents/Critique.md` |
| **Deliver** | Hand over a passing artifact | `Intents/Deliver.md` |
| **Calibrate** | Record the principal's score and note | `Intents/Calibrate.md` |

| File | Read when |
|------|-----------|
| `References/Rubric.md` | writing a brief or reading a critique: the anchored axes, document and figure rules, defect shape and the `Brief.json` schema (`References/BriefExample.json` is a filled brief); Critique reads it at runtime |
| `Setup.md` | first-time setup: the two judge vendors' access, ffmpeg for films, and a no-cost proof |

## Tool contract

Run with `bun skills/ArtDirection/` prefixed to each tool path, from the config root.

| Tool | CLI contract |
|---|---|
| Critique | `Tools/Critique.ts --video <mp4> \| --image <png> [--images <glob>] --brief <Brief.json> [--bar 8.5] [--samples 12] [--concurrency N] [--vendors openai,anthropic] [--sample-seed <n>] [--out <dir>] [--json] [--allow-identity]` |
| Deliver | `Tools/Deliver.ts --artifact <file> [--critique <Critique.json>] --to <dir>` |
| Calibrate | `Tools/Calibrate.ts --artifact <file> --verdict <1-10> --note "<text>"` |

Each intent file carries its tool's defaults, refusals and exit codes.

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ArtDirection/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When it exists, its PREFERENCES.md, configurations and resources override the defaults here; when absent, the defaults stand. First-time setup (accounts, keys, config, a proof it works) is in [Setup.md](Setup.md).

- A brief may name `"calibration": "<target>"`. Critique then adds that Calibrate target's `Taste.json` (the principal's labeled likes and dislikes) to the judge prompt and records its `labels_hash` in the report; a target with no profile yet is noted under `outstanding`. Briefs without the field produce the prompt they always did.
- Calibration labels append to `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ArtDirection/labels.jsonl` (fields in `Intents/Calibrate.md`).
- The panel is the vision vendors named by `art_judges` in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ArtDirection/Config.md` (OpenAI, Anthropic and Google have seats; a missing file or key stops the critique with an error naming both). That folder's `PREFERENCES.md`, when present, is appended to `References/Rubric.md` as install-specific judging rules, and `check_set.version` hashes the two together. OpenAI vision runs as `codex exec -i` through the codex CLI signed in to ChatGPT (`Assay/Tools/OpenAIVision.ts`; no API key is read); Anthropic vision runs through `LIFEOS/TOOLS/Inference.ts` image input (the claude CLI on the subscription), never falling back to another vendor. Panel selection (`--vendors`) is in `Intents/Critique.md`. No credentials belong in briefs or logs.
- Models come from `LIFEOS/TOOLS/models.ts`: `CROSS_VENDOR.openaiJudge` for OpenAI and the high rung of `EFFORT_MODEL` for Anthropic, never pinned here.
- Preferences use configRoot above; the current credential and label implementations use the home `.claude` location.

## Gotchas

- Hand-over is gated by `Deliver.ts` because a first-draft video reached the principal with no critique on 2026-09-17, while the rule lived only in prose (the story is in the USER extension's `History.md`).
- The rubric leads with `concept` (does the artifact carry its idea as one metaphor a stranger reads at a glance), and overall follows concept most. Changed 2026-09-28 after the principal's first Calibrate scores showed the old craft-first rubric ranking the scored artifacts almost at random (the measurement is in the USER extension's `History.md`).

## Examples

User: "iterate until it's great" on a render → Loop intent → `Brief.json` and `Direction.md` exist, critique rounds run until the artifact passes the bar, or the four-round cap is reported with its shortfall.

User: "rate the visuals" → Critique intent → `Critique.json` with both vendors' scores, ranked defects and a pass, fail or unavailable verdict.

User: "that one's a 6, the type is cramped" → Calibrate intent → one label appended with verdict 6 and the note in the principal's words.
