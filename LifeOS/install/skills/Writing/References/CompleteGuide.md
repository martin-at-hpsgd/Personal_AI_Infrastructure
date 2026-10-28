# Writing — Complete Guide

**Contents:** References · Data & Config · Tools · Hard Formatting Rules (every voice, every mode) · Rewrite and Detect · Integration · Gotchas · Examples

## References

- **Patterns:** `LIFEOS/DOCUMENTATION/Writing/AIWritingPatterns.md` — exhaustive detection reference (word tables, pattern categories, severity tiers, context profiles)
- **Voice — what to avoid:** `LIFEOS/USER/PRINCIPAL/WRITINGSTYLE.md` — the ban list, forbidden constructions, the negation rule
- **Voice — what to aim at:** `<voice_dir>/VoiceProfile.md` — the corpus-derived positive model. Read this WITH the ban list; neither works alone.
- **Voice — the anchor:** `anchor:` in `<voice_dir>/Corpus.md` names the piece the principal nominated; `VoiceProfile.md` § The anchor piece extracts its moves and `Exemplars.md` § Anchor carries the passages. When asked to write as the principal, read the anchor piece in full from `corpus_root` before drafting.
- **Install notes:** `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/Config.md` § Install notes, when present — this install's own rulings and lessons about the principal's voice. They outrank the general guidance here.
- **Analytical voice:** `LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md` § Writing Style — the DA's voice (if auditing DA-authored content)

`<voice_dir>` is set in the skill config (§ Data & Config). Read `AIWritingPatterns.md` before every audit. It contains the complete word replacement table, severity tiers, and context-specific tolerance matrix.

## Data & Config

The voice model is DATA and lives in the USER tree; this skill is code and holds none of it. Set-up steps and examples: `Setup.md`.

The skill config is `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/Config.md`, read by `Tools/WritingConfig.ts`:

| Key | Required | What it is |
|---|---|---|
| `voice_dir` | yes | Directory holding the voice model (table below); absolute, or relative to the install root |
| `corpus_cli` | no | A published-content index CLI (`status`, `opinion "<topic>"`, `post "<topic>" <n>`) the voice intents query for the principal's published positions. Unset means that check is skipped and reported as skipped |
| `judge_hedge_examples`, `judge_plain_word_examples`, `judge_excitement_examples`, `judge_worry_examples` | no | Example phrases the voice judge quotes in its rubrics; unset, the rubrics point the judge at the exemplars |
| `remedy_hedges`, `remedy_intensifiers` | no | Example words the voice gate prints in two of its remedies |
| `banned_patterns`, `hard_zero`, `house_style_only` | no | Comma-separated construction names, or `none`, replacing the gate's defaults for what is counted, what fails a draft outright, and what is fixed as house style. Unset keeps the defaults; `Setup.md` lists the names |
| `## Register rubric` section | no | Legacy home of the register rubric; `PREFERENCES.md` beside the config is its home now and wins when both are set |
| `preview_browser` | for Preview | The browser app the Preview intent opens a rendered draft in (macOS `open -a`) |
| `## Short-form judge note` section | no | One standing note appended to every short-form judge rubric |
| `## Install notes` section | no | Install-specific rulings and lessons the intents read |

`PREFERENCES.md` beside the config holds tastes: `## Severity overrides` and `## House vocabulary (never flagged)` for the AI-pattern audit, and `## Register rubric`, which replaces the long-form judge's neutral register rubric (graded against the exemplars) or, with a body of `none`, drops that dimension.

The files in `voice_dir` (`Corpus.md`, `VoiceProfile.md`, `VoiceProfile.json`, `Exemplars.md`, `PostExemplars.md`) are tabled in `Intents/WriteAsPrincipal.md` § Inputs, which the `principal` bundle loads with this section.

With no config, `VoiceGate.ts` and `VoiceJudge.ts` stop with exit 2 and name `Setup.md`; `VoiceGate.ts --profile <file>` runs without it. `bun Tools/WritingConfig.ts status` reports what is configured and what is missing.

## Tools

| Tool | What it does |
|---|---|
| `Tools/WritingConfig.ts` | Reads the skill config. `status` reports whether the voice model is configured (exit 0) or what is missing (exit 1). |
| `Tools/VoiceMetrics.ts` | Measures any text — sentence-length distribution, paragraph shape, fragment rate, first/second person, hedges, intensifiers, contractions, initial conjunctions, questions, clauses per sentence, and forbidden-construction counts. Prints JSON or a table. |
| `Tools/BuildVoiceProfile.ts` | Runs the metrics across the corpus and emits the target bands. Re-run after any corpus edit. `--compare <draft>` shows a draft against every band side by side. |
| `Tools/VoiceGate.ts` | The deterministic gate. Fails on any forbidden construction, any retired house-style habit, or three-plus collapsed core metrics — and prints a specific remedy per failing metric. Exit 0 pass, 1 fail, 2 the gate did not run (no config, no voice profile, or no draft given); treat exit 2 as a fail, never a pass. |
| `Tools/VoiceJudge.ts` | The model-graded judge. Six corpus-derived dimensions (five when the config drops the register rubric), graded against the exemplars via the `Assay` skill's `Judge.ts`. Every dimension must clear threshold, not just the weighted average. Exit 0 pass, 1 fail, 2 did not run. |
| `PangramScore.ts` (LIFEOS/TOOLS) | Empirical AI-detection score. Reported, never a gate. |

## Hard Formatting Rules (every voice, every mode)

- **Em dashes are closed by default.** `word—word`, never `word — word`, in the principal's voice and the DA's voice alike. Spaced em dashes are a flag in detect mode and get closed in every rewrite. This rule is the default `house_style_only` entry (`spaced-em-dash`) in the skill config; an install that sets `house_style_only` without it keeps its spaced dashes, and detect and rewrite follow that setting.
- **Negation constructions are banned by default.** "It's not X, it's Y", "not just X but Y", "the question isn't" and their relatives are flagged and rewritten as positive claims. They are the default `hard_zero` entries in the skill config; an install that removes one there stops treating it as a hard ban, and detect and rewrite follow that setting.

## Rewrite and Detect

The Rewrite (default) and Detect contracts, their Ideal State, Anti-criteria and output formats, live in `Intents/Rewrite.md` and `Intents/Detect.md`. Triggers for both are in SKILL.md § Intent Routing.

## Integration

This skill can be invoked:
- **Standalone:** "deai this post", "audit this draft for AI tells", "score this for AI"
- **From a blog workflow:** rough dictated or spoken source material routes to Assemble before the blog draft wrapper. Finished supplied text and an explicit verbatim request remain verbatim placement.
- **Before publishing:** run `detect` then `ScoreAI` — heuristic flag plus empirical Pangram score
- **From a social-post workflow:** audit social copy before posting; `VoiceJudge.ts --short` grades it against `PostExemplars.md`
- **On any text:** Works on blog posts, newsletters, emails, social posts, documentation

**detect** flags the AI-isms, **rewrite** fixes them, and **ScoreAI** reports what a trained detector makes of the text before and after. The score is reported alongside the revision, never used as a target or a pass/fail test. See `Intents/ScoreAI.md`.

## Gotchas

- **Some flagged patterns are legitimate writing.** In detect mode, separate clear problems from judgment calls instead of demanding every flag be fixed.
- **ScoreAI (Pangram) is blunt on short text, billed per call, and one detector.** A plain-voice paragraph and deliberate slop can both score 100% at a few sentences. The caveats and the calibrated baseline are in `Intents/ScoreAI.md` § Output format and § Inputs.
- **The words that fail are ordinary.** A piece that passes every banned-word table can still read as machine prose through narrator's asides (a clause that leaves the specific case to speak for people in general) and rhythm tells; catching them is a read, never a grep.
- **Stripping AI-isms with no positive target produces its own tell.** What survives a pure ban pass is minimalist staccato, which reads as machine-written to any careful reader while satisfying every rule and scoring ~100% on Pangram. Any rewrite of long-form prose in the principal's voice runs `WriteAsPrincipal`, not bare Rewrite mode.
- **If your corpus predates a ban, your own writing breaks it.** A construction you ban after most of the corpus was written still appears in the corpus, so its band would license it. List it under `hard_zero` or `house_style_only` in the skill config and `VoiceProfile.json` records it, so a band never licenses it. When copying an exemplar's move, restate it under the current rules.
- **A corpus entry can be AI-written with no authorship marker.** A post can carry an in-body note that an assistant researched and wrote it, with no AI-authorship line at all, so a marker grep alone passes it through. Corpus selection also greps the body for authorship claims. Training on one of these launders the assistant's voice back as the author's.
- **Recalibrate the gate whenever the corpus changes.** The failure threshold is tuned by running the gate over the corpus itself and measuring how often the author's own published work would be rejected, then confirming a known collapsed draft still fails. The method is in `VoiceGate.ts`'s `CORE` comment; record each run in the config's calibration log.
- **Both gates passing is necessary, not sufficient.** They catch collapse. A draft can sit at the corpus median on every metric and still be dull or wrong.
- **The anchor piece may fail the gate, and that can be expected.** If the anchor predates a ban, it carries the banned construction (`hard_zero` outranks the corpus), and an anchor often runs HIGH on core metrics. HIGH on a core metric never blocks and its remedy is descriptive. Do not "fix" the gate to make the anchor pass, and do not read the anchor's HIGHs as something to trim in a draft — the gate line prints the anchor's own value beside the band so you can see when a draft is high where the anchor is high.
- **Keep a collapsed-draft fixture.** Recalibration needs a draft known to collapse. If you later repair that draft in place, its collapsed version survives only in version history; note where in the config's install notes.

## Examples

**Example 1: Default rewrite**
```
User: "deai this draft"
→ Detect context profile (blog), audit against AIWritingPatterns.md
→ Rewrite in WRITINGSTYLE.md voice, show diff summary
→ Second-pass audit, fix survivors
```

**Example 2: Flag only**
```
User: "scan this LinkedIn post for AI tells, don't change it"
→ Detect mode: tiered P0/P1/P2 flag report
→ Marks each flag as clear problem vs judgment call; no edits
```
