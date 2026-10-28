# Writing

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun ~/.claude/skills/Writing/Tools/WritingConfig.ts status` · optional

## What it does

This skill writes and repairs long-form prose in your own voice, turns dictated or rough spoken notes into readable prose without inventing anything, audits any text for AI-writing patterns (flag only, or flag and fix), scores text with the Pangram AI detector, and renders a draft as a page you can read in your browser.

The pattern audit and the transcript assembly work with no set-up at all. Writing in your voice needs a voice model: a small set of files describing prose you actually wrote, measured into target bands. The skill holds the tools (`VoiceMetrics.ts`, `BuildVoiceProfile.ts`, `VoiceGate.ts`, `VoiceJudge.ts`); the model is your data and lives under `LIFEOS/USER/`. A config file tells the tools where it is. Until it exists, the voice gate and judge stop with exit 2 and point back here.

Optional extras: a published-content index you can query for your past positions (any CLI that answers `status`, `opinion "<topic>"` and `post "<topic>" <n>`), a Pangram account for detector scores, and the Interceptor skill, which the Preview intent uses to look at a rendered draft before opening it for you. Without Interceptor, Preview still renders and opens the page and says it was not checked visually.

The voice gate's construction checks are defaults, not rules about your voice. It counts eleven machine-prose constructions, blocks eight of them outright (`hard_zero`), and treats a spaced em dash as a retired habit (`house_style_only`, so the default style is a closed `word—word` dash). The long-form judge's register rubric holds no taste of its own: it grades whether a draft's emotional register matches your exemplars. Each construction check is a config key below, and your preferred register goes in `PREFERENCES.md`; leave a key or section out to keep the default.

## Fill in

### `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/Config.md`

Smallest working example:

```markdown
---
voice_dir: LIFEOS/USER/PRINCIPAL/VOICE
preview_browser: Firefox
---

# Writing config
```

A fuller example:

```markdown
---
voice_dir: LIFEOS/USER/PRINCIPAL/VOICE
corpus_cli: tools/my-posts/search.ts
preview_browser: Safari
judge_hedge_examples: I reckon, more or less, I could be wrong
judge_plain_word_examples: "neat", "handy", "rough"
judge_excitement_examples: "This one is great", "Go read it."
judge_worry_examples: "This worries me"
remedy_hedges: I reckon, more or less, my guess is
remedy_intensifiers: really, honestly great, the fun part
sentence_reach_words: 25-40
hard_zero: negation-pair, not-just-but, delve-tapestry
house_style_only: none
---

# Writing config

## Short-form judge note

Alex Example opens every short post in the Field Notes series with "Field notes:" and a topic word. That line is content, not shape; grade the rest of the post.

## Install notes

- Alex Example stopped using semicolons in 2025; older corpus pieces still have them.

## Calibration log

| rule | corpus false-positive | corpus |
|---|---|---|
| low-only, 3 misses | 5.0% (1/20) | 20 docs |
```

| Field | Required | What it is |
|---|---|---|
| `voice_dir` | yes | Directory holding your voice model files (next table). Absolute, or relative to the install root (the folder that holds `LIFEOS/`). |
| `corpus_cli` | no | A CLI that searches your published writing. When set, the voice intents check your published position on a topic before drafting; when unset they skip that check and say so. |
| `preview_browser` | for previews | The browser app a rendered draft opens in (macOS `open -a "<app>"`). |
| `judge_hedge_examples`, `judge_plain_word_examples`, `judge_excitement_examples`, `judge_worry_examples` | no | Example phrases from your own writing that the voice judge quotes in its rubrics. Unset, the rubrics tell the judge to read them off your exemplars. Keep any quotes you want shown. |
| `remedy_hedges`, `remedy_intensifiers` | no | Words the voice gate suggests when a draft has no hedging or no visible enthusiasm. Unset, it suggests a short neutral list. |
| `sentence_reach_words` | no | The word range your explanatory sentences reach (read it off `VoiceProfile.md`), e.g. `25-40`. The voice judge and gate name it; unset, they ask for long sentences with no range. |
| `banned_patterns` | no | Comma-separated names of the constructions `VoiceMetrics.ts` counts. Unset, it counts all eleven: `negation-pair`, `not-just-but`, `the-question-isnt`, `heres-the-thing`, `its-not-about`, `reaction-reveal`, `narrator-aside`, `in-a-world-where`, `spaced-em-dash`, `delve-tapestry`, `copula-avoidance`. `none` counts nothing. An unknown name stops the tools with exit 2. |
| `hard_zero` | no | Constructions that fail a draft whatever your corpus does, because a corpus written before you banned something still contains it. Unset, it is every name above except `reaction-reveal`, `narrator-aside` and `spaced-em-dash`. `none` blocks nothing. Every name must also be counted. |
| `house_style_only` | no | Constructions fixed on sight as house style. Unset, it is `spaced-em-dash`. `none` turns it off, which is the setting for anyone who writes spaced em dashes on purpose. |
| `## Short-form judge note` | no | One standing note added to every short-post rubric. |
| `## Install notes` | no | Your own rulings and lessons about your voice. The voice intents read them and let them outrank the skill's general guidance. |
| `## Calibration log` | no | A record of each time you recalibrated the voice gate against your corpus. |

### `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/PREFERENCES.md` (optional)

Same directory as `Config.md`. Your writing tastes; delete the file, or any section, to keep the skill's neutral defaults. A made-up example:

```markdown
---
version: 1.0.0
---

# Writing — Preferences

## Severity overrides

- **Negations of any shape are a hard P0 ban** in Alex Example's voice.

## House vocabulary (never flagged)

- `flywheel` — Alex Example's own strategy vocabulary.

## Short register rubric

Does the post sound level and specific?

5 — The reaction is stated plainly and tied to one concrete detail.
3 — Level, but vague.
1 — Breathless or portentous. Ends on an abstraction.

## Register rubric

Is the register calm and exact rather than breathless?

5 — Claims are stated at the strength the evidence supports. Concrete examples carry the stakes.
3 — Even, but vague.
1 — Breathless or portentous. Ends on an abstraction.
```

| Section | Read by | What it is |
|---|---|---|
| `## Severity overrides` | the AI-pattern audit (`LIFEOS/DOCUMENTATION/Writing/AIWritingPatterns.md`) | Patterns whose severity you raise or lower for your voice, one bullet each, for example making negations a hard ban. |
| `## House vocabulary (never flagged)` | the AI-pattern audit | Words you use on purpose, one bullet each, that the audit must not flag even where the generic pattern list would. |
| `## Short register rubric` | `Tools/WritingConfig.ts`, graded by `VoiceJudge.ts --short` | Your preferred register for short posts as a 5/3/1 rubric. It replaces the neutral default, which grades whether the post's register matches your reference posts (`PostExemplars.md`). The whole section body is the rubric. A body of exactly `none` drops the dimension from the short-form judge. Read from this file only. |
| `## Register rubric` | `Tools/WritingConfig.ts`, graded by `VoiceJudge.ts` | Your preferred long-form register as a 5/3/1 rubric. It replaces the neutral default, which grades whether the register matches your exemplars. The whole section body is the rubric, so keep commentary out of it. A body of exactly `none` drops the register dimension. An older install's `## Register rubric` in `Config.md` still works; this file wins when both are set. |

### The voice model, in `voice_dir`

`Corpus.md` lists the pieces you wrote yourself. The table rows are what the profile builder reads; `corpus_root` is the folder holding the files, one `<slug>.md` per row; `anchor` is the one piece you like best of your own.

```markdown
---
corpus_root: /srv/alex-example/essays
anchor: why-i-garden
---

# Corpus

Selection rule: long-form pieces Alex Example wrote alone, 600 words or more.

| # | slug | title |
|---|---|---|
| 1 | `why-i-garden` | Why I Garden |
| 2 | `bus-routes` | Notes on Bus Routes |
| 3 | `first-workshop` | My First Workshop |
```

`Exemplars.md` holds verbatim passages from those pieces, grouped by the move they show. Include a `## Anchor` section with passages from the anchor piece.

```markdown
# Exemplars

## Anchor

> I started the garden because the yard was ugly, honestly, and I kept it because it made me slow down.

## Long sentence that carries the argument

> When I finally mapped every bus route on one sheet, which took most of a weekend, I could see why the crosstown line never fills up.
```

`PostExemplars.md` holds a handful of your real short posts, verbatim, one per section. It is needed only for `VoiceJudge.ts --short`.

`VoiceProfile.md` is your own readable description of the moves your prose makes, each with a number from the metrics or a quoted passage. The tools do not parse it; the voice intents read it.

`VoiceProfile.json` is generated, never hand-written:

```bash
bun ~/.claude/skills/Writing/Tools/BuildVoiceProfile.ts --manifest <voice_dir>/Corpus.md --out <voice_dir>/VoiceProfile.json
```

The profile records the `hard_zero` and `house_style_only` lists it was built with. A key you set later in the config outranks the recorded list, so the gate follows the config without a rebuild; a key you leave unset keeps the recorded list.

| File | Made by | Read by |
|---|---|---|
| `Corpus.md` | you | `BuildVoiceProfile.ts` |
| `Exemplars.md` | you | `VoiceJudge.ts` (long-form) |
| `PostExemplars.md` | you, optional | `VoiceJudge.ts --short` |
| `VoiceProfile.md` | you | the voice intents |
| `VoiceProfile.json` | `BuildVoiceProfile.ts` | `VoiceGate.ts` |

The style guide the rewrite and voice intents follow is `LIFEOS/USER/PRINCIPAL/WRITINGSTYLE.md`, which LifeOS already ships as a template.

## Accounts and secrets

| Account | Env key in `~/.claude/.env` | Where to get the value |
|---|---|---|
| Pangram (AI-detection scores; only the ScoreAI intent uses it) | `PANGRAM_API_KEY` | Create an account at pangram.com and copy an API key from its dashboard. Calls are billed per word. |

The voice judge grades through the Assay skill's judge and needs no key of its own.

## Prove it works

Measure one sentence. This reads nothing but the text you pass and needs no set-up:

```bash
bun ~/.claude/skills/Writing/Tools/VoiceMetrics.ts --text "I think the bus is late again, and honestly I am fine with it." --pretty
```

Success is a header line `inline  (14w · 1s · 1p)` followed by a table of metrics, with `first_person_density` and `hedge_density` both `14.29`.

Then check the config:

```bash
bun ~/.claude/skills/Writing/Tools/WritingConfig.ts status
```

Before set-up it prints `writing config: NOT CONFIGURED` and exits 1. Once your config and voice files exist, it prints `writing config: configured`, an `ok` line for each voice file, and exits 0.
