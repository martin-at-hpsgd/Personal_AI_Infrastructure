# VideoEssay

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: `bun skills/VideoEssay/Tools/Setup.ts --check` · optional

## What it does

VideoEssay turns a piece of content and a stance into a narrated video essay, or turns an author's own blog post plus a reading of it (a recording, a voice clone, or the DA reading the exact words) into a finished video of that post. It writes the argument first, scripts the visuals, synthesizes or aligns the narration, renders on HyperFrames, and reads its own render back before anyone sees it. Nothing is uploaded; every run stops in review.

It needs a set of licensed font files (the design system embeds them and never falls back to a system face), a portrait for the DA and optionally one for the author, a Fish Audio account for narration, the pinned HyperFrames CLI (installed by `Setup.ts`), `ffmpeg`, ImageMagick, and the Interceptor test browser profile for page captures. `rembg` is optional; without it the thumbnail uses the opaque portrait.

## Fill in

### `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/VideoEssay/Config.json`

Smallest working file. Every face id in `Tools/Theme.ts` `FACES` must be present; `Setup.ts --check` names any that are missing.

```json
{
  "fonts": {
    "serif": "~/Fonts/ExampleSerif-Regular.otf",
    "serifBold": "~/Fonts/ExampleSerif-Bold.otf",
    "serifItalic": "~/Fonts/ExampleSerif-Italic.otf",
    "serifTabBold": "~/Fonts/ExampleSerif-TabBold.otf",
    "figures": "~/Fonts/ExampleFigures-Semibold.otf",
    "sans": "~/Fonts/ExampleSans-Regular.otf",
    "sansTab": "~/Fonts/ExampleSans-Tab.otf",
    "caps": "~/Fonts/ExampleSans-Caps.otf",
    "kicker": "~/Fonts/ExampleCaps-Tab.otf",
    "kickerBold": "~/Fonts/ExampleCaps-Bold.otf",
    "display": "~/Fonts/ExampleCaps-Narrow.otf",
    "cite": "~/Fonts/ExampleCaps-Condensed.otf",
    "quote": "~/Fonts/ExampleQuote-Regular.otf",
    "mono": "~/Fonts/ExampleMono-Regular.otf"
  },
  "avatar": "da-portrait.png",
  "runsRoot": "~/Videos/essay-runs",
  "blogBaseUrl": "https://blog.example.com/posts/",
  "possessive": "their",
  "presenter": { "avatar": "author.png", "label": "ALEX", "badge": "a" },
  "narrators": { "da": { "reader": "NOVA", "badge": "b", "seed": 100, "takes": 2 } },
  "styleFile": "EssayStyle.md"
}
```

Put the two portraits beside `Config.json`: `da-portrait.png` (the DA's square portrait, read for every run) and `author.png` (the author's square portrait, read for voice-mode runs). Square PNGs of at least 512 px work best. A relative `avatar` resolves against this folder like the others; without `avatar`, the skill looks for `LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY_AVATAR.png`.

`styleFile` is optional: a Markdown list of the writing rules the Argue intent holds every essay to, for example:

```markdown
# Essay style
- Paragraphs of at most three sentences, each ending on a fact.
- No em-dashes.
- Quote the source verbatim; paraphrase only in your own sentences.
```

| Field | Required | Meaning |
|-------|----------|---------|
| `fonts.<face id>` | yes | Path to the font file for that face: absolute, `~/`, or relative to this config's directory. Which cut belongs in each id is in § Faces and colours. |
| `avatar` | no | The DA's portrait. Default `LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY_AVATAR.png`. |
| `runsRoot` | no | Where run directories live. Must sit outside every git repo. Default `~/VideoEssays`; env `LIFEOS_VIDEOESSAY_DIR` overrides. |
| `blogBaseUrl` | voice mode | Base URL that turns a local markdown post's slug into its live https URL. |
| `possessive` | no | The author's possessive for the badge's read-by line on a DA-read run: `his`, `her` or `their` (case ignored, one short word). The badge reads `READ BY <READER> · THEIR AI` by default; set `his` for `· HIS AI`. A reader name too long for the badge band drops the tail. |
| `presenter.avatar` | voice mode | The author's portrait for the corner badge, absolute or relative to this config's directory. Without it voice mode is unavailable. |
| `presenter.label` | no | The author name on the badge. Default: the first word of `principal.name` in `LIFEOS_CONFIG.toml`, uppercased. |
| `presenter.badge` | no | Badge design: `a`, `b`, `c`, `d`, `e` or `d-dark`. Default `a`. |
| `narrators.da.avatar` / `label` / `reader` / `badge` | no | The corner of a run the DA reads aloud. `reader` defaults to the DA display name in `LIFEOS_CONFIG.toml`. |
| `narrators.da.seed` / `takes` | no | Base seed (integer, default 1) and number of takes (default 3) for the best-of-N DA read. |
| `fontFamilies.<face id>` | no | The family name that face's file must report (a prefix, or a list of them); `DesignAudit.ts --check config` fails a file that reports another family. Unset ids are only checked for being readable fonts. |
| `colors` | no | Colour overrides, every key optional (§ Faces and colours). Each value is `#rrggbb`. |
| `badge` | no | The words a voice badge prints: `header`, `andNot`, `struck`, `wordsLine` (must contain `{LABEL}`), each 1 to 24 characters. Defaults `VIDEO ESSAY`, `AND NOT`, `A SUMMARY`, `{LABEL}'S OWN WORDS`. |
| `skipParagraphs` | no | JavaScript regular expressions (strings, case-sensitive) for post paragraphs that are page metadata and never read aloud (§ Supported post format). |
| `styleFile` | no | The essay writing rules file, beside this config. |

### Faces and colours

Each face id is a role, and the file you map to it should be that kind of cut:

| Face id | What belongs there |
|---|---|
| `serif`, `serifBold`, `serifItalic` | the body serif: regular, bold, italic |
| `serifTabBold` | the body serif with tabular lining figures, bold (chapter numerals) |
| `figures` | a display face for big numbers, semibold |
| `sans`, `sansTab` | a sans, and its tabular-figure cut |
| `caps` | a small-caps sans: lowercase source renders as small caps |
| `kicker`, `kickerBold` | a condensed all-caps face, tabular and bold (kickers, the badge, the thumbnail title) |
| `display` | a narrow all-caps face for headings |
| `cite` | a condensed all-caps face for attributions |
| `quote` | a serif for quotations |
| `mono` | a monospace for code |

The caps roles are set in a forced case (`caps`, `display`, `cite` lowercase; `kicker` uppercase). An ordinary face there still renders, in that case. One family may fill several roles: map the same file to more than one id.

`colors` keys: `accent` (the brand colour: badge signal, essay ring, progress line, thumbnail border), `highlight` (the reading highlight), `paper` (voice-mode ground when a run has no capture), and the token sets `paperInk` and `darkInk` (`ink`, `secondary`, `muted`, `rule`, `connector`, `accent`; `darkInk` also `ground` and `codeGround`). Defaults and roles are in `References/Style.md` § Colour. A worked example with made-up values, a navy brand on warm paper:

```json
"fontFamilies": { "serif": "Example Serif", "mono": "Example Mono" },
"colors": {
  "accent": "#1E3A8A",
  "highlight": "#FDE68A",
  "paper": "#F5F0E6",
  "paperInk": { "accent": "#1E40AF" },
  "darkInk": { "ground": "#0A0F1E", "accent": "#93C5FD" }
},
"badge": { "header": "READ ALOUD", "struck": "A SUMMARY" }
```

`Setup.ts --check` refuses a malformed colour, an unknown key or an over-long badge line, naming it.

### Supported post format

Voice mode reads a post from a local Markdown file (with `blogBaseUrl` set, or a `url:` you pass) or from its live https page. Frontmatter `title`, `slug` and `author` are read when present. Narrated: body paragraphs, list items, and block quotes with no attribution (the author's own words set off). Never narrated: headings, fenced code, tables, `<aside>`, `<callout>`, `<notes>` and `<footnotes>` blocks, attributed quotes (a trailing `— Name` line, a `<cite>`, or an author attribute), captions, images, and any capitalized component carrying a `url` attribute (a link card or embed such as `<LinkCard url="…" />`, whose link is kept for the description). On a live page the body is found by paragraph density, page chrome (`nav`, `header`, `footer`, `aside`) is dropped, and elements whose class ends in `loading`, `skeleton` or `spinner` are waited out during capture. A site-specific metadata line goes in `skipParagraphs`; for example, a footer line like `📁 Filed under: Garden notes` is skipped with:

```json
"skipParagraphs": ["^[^A-Za-z0-9]*Filed under:"]
```

A wrong decision for one block is overridden per run in `Source/narration-overrides.json` (see `Intents/Voice.md`).

### The voice-clone credit

Clone runs carry a voice-clone credit on the badge: the vendor-neutral label `AI VOICE CLONE` from `Tools/Theme.ts` `VOICE_CREDIT`. It names no company and needs no logo files, because narration is synthesized on Fish Audio and a credit to any other vendor would be wrong. The rest of `public/` is created by `Setup.ts`.

### `LIFEOS_CONFIG.toml`

The file is `~/.claude/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml`. Narration is synthesized on Fish Audio. The DA has one voice, `[da.voices.main]`, and every tool that speaks as the DA uses it; any other `[da.voices.*]` profile is ignored by narration. It must carry a `voice_id` (the profile's own id; narration matches it to the profile) and a `fish_reference_id` (the Fish Audio voice model id, from the voice's page on fish.audio); without the Fish id narration stops with `fish_reference_id`. `fish_speed` is the reading pace Fish applies (1.0 when unset), so nothing is stretched afterward. Clone runs also need `[principal.voice]`, which holds the clone's settings: every field but `takes` is required, the three dials are numbers from 0 to 1, `seed` is a whole number, and a `voice_id` there is refused because the clone's ids live in `.env` (§ Accounts and secrets). `model_id` is any non-empty label; narration reads it only as part of the take's cache key. With made-up values:

```toml
[da.voices.main]
voice_id = "ExampleVoiceId123"
fish_reference_id = "0123456789abcdef0123456789abcdef"
fish_speed = 1.0

[principal.voice]
model_id = "fish"
stability = 0.5
similarity_boost = 0.8
style = 0.0
use_speaker_boost = true
seed = 12345
takes = 3
```

## Accounts and secrets

- **Fish Audio** (fish.audio): create an API key under the API keys page of your account and put it in `~/.claude/.env` as `FISH_API_KEY`. Narration calls Fish's text-to-speech with word timestamps; without the key the first narration stops with `missing FISH_API_KEY in the env file`. Give the DA's profile a Fish voice by putting its model id in `fish_reference_id` (§ `LIFEOS_CONFIG.toml`).
- **Voice clone** (only for `--narrator clone`): make a voice clone of the author on Fish Audio and put its voice model id in `~/.claude/.env` as `FISH_PRINCIPAL_VOICE_ID`. Also set `ELEVENLABS_PRINCIPAL_VOICE_ID` there to an id of your own that names the clone and nothing else: narration recognizes a clone read by this id and routes it to `FISH_PRINCIPAL_VOICE_ID`. It must not be `main`, `presenter` or `principal`, because narration reads those as role names before it checks for the clone (`main` or `presenter` would read the author's words in the DA's voice), and it must not be the `voice_id` of any `[da.voices.*]` profile, because that profile's reads would then go to the clone. Clone runs stop with `missing ELEVENLABS_PRINCIPAL_VOICE_ID in the env file` when it is missing.
- **Font licenses**: buy or obtain the font files you list under `fonts`. They are embedded into renders straight from the paths you give and are never copied into a repo.
- **Interceptor**: an isolated Chrome profile set up through the public Interceptor skill; captures run there, never in your everyday browser profile, so no signed-in account or open tab shows in a frame. Put its context id in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env` as `INTERCEPTOR_TEST_CONTEXT_ID="<id>"` (with or without a leading `export`, the form the Interceptor guide writes). `Capture.ts` stops with `Interceptor preferences.env missing` and the file's path when the file is absent.
- **Model access for the meaning review**: the meaning map and its review (`LIFEOS/TOOLS/VideoMeaning/VideoMeaning.ts`, whose output `Tools/Meaning.ts` reads) ask models through `LIFEOS/TOOLS/Inference.ts`, which runs Anthropic through the `claude` CLI signed in to your Claude subscription and OpenAI through the `codex` CLI signed in to your ChatGPT subscription; no API key is needed. Check both with `claude --version` and `codex login status`.
- **AI-detection score** (optional, Argue gate 3): a Pangram Labs API key in `~/.claude/.env` as `PANGRAM_API_KEY` (pangram.com → dashboard → API keys). Without it, that gate is skipped and the essay says so.

## Prove it works

Run `bun skills/VideoEssay/Tools/Setup.ts` once without `--check` first: that is the install step (dependencies, the pinned HyperFrames CLI, the avatar cut-out, the `public/` link). Everything below leaves your files alone. (`--check` only creates the empty `public/` store folder and its link if they are missing.)

```bash
bun skills/VideoEssay/Tools/Setup.ts --check
```

Success prints one line starting `✓ composition ready · fonts: 14 faces`, followed by the avatar, presenter and DA narrator states. With no config file it fails with `video essay config not found` and names this guide.

### A worked example: your first essay file

The argument is the one piece you write by hand before any narration or render. Make a run folder under your `runsRoot` and put this made-up `Essay.md` in it (`~/Videos/essay-runs/example-run/Essay.md` with the config above):

```markdown
---
title: Gardens Do Not Scale Like Factories
thesis: A community garden grows by adding gardeners, not by adding rows, so the plan that doubles the plots without doubling the volunteers will fail by midsummer.
source: https://video.example.com/watch/garden-talk
stance: disagree with the expansion plan
attribution_unsure: []
---

## Their Claims

> If we double the plots this spring, we double the harvest by fall.
> — Pat Example

## Where We Agree

More plots would feed more people if every plot were tended.

## The Disagreement

The talk treats a plot as the unit of output. The plot is only land; the unit of output is a tended plot, and tending is the scarce part.

## The Argument

Every garden I have seen fail did not run out of soil. It ran out of people willing to weed in July. Doubling the rows without a plan for the people who tend them doubles the weeds first.
```

Then lint it:

```bash
bun skills/VideoEssay/Tools/EssayLint.ts --run example-run
```

Success prints `91 words (quotes excluded) · 1 quotes` and `✓ essay ok`, and exits 0. Delete the `## Where We Agree` section and run it again: it prints `✗ section missing: ## Where We Agree` and exits 1. The linter reads the file and writes nothing.
