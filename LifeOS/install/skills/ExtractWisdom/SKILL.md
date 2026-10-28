---
name: ExtractWisdom
metadata:
  short-description: "Extract content-adaptive wisdom or the N highest-alpha ideas from articles, videos, and interviews. Use Fabric for fixed prompt patterns."
evals:
  suites: [extractwisdom-contract]
version: 1.3.1
description: "Content-adaptive wisdom extraction (sections built around what the content holds, five depth levels, mandatory contrarian takes) and extract alpha (the N highest-alpha, net-new ideas as short ranked bullets) from videos, podcasts, articles, files or text, from the full source. USE WHEN extract wisdom, ew, extract alpha, ea, highest-alpha ideas, what is new in this, analyze video, analyze podcast, extract insights, key takeaways, summarize interview, distill content. NOT FOR static Fabric extract_wisdom pattern (use Fabric), or multi-source web investigation (Research)."
---

# ExtractWisdom — Dynamic Content Extraction

Pulls the best ideas out of videos, podcasts, interviews, and articles. It reads the content first, detects what kinds of wisdom are actually in there, then builds custom sections around what it finds instead of forcing the same headers every time. Five depth levels from Instant to Comprehensive. At Full (the default) and Comprehensive, output ends with a one-sentence takeaway, an "If You Only Have 2 Minutes" list, and references worth following. Alpha is the narrower cut: only the ideas that are new to a well-read reader, as N short ranked bullets. Both intents are our ports of Fabric's `extract_wisdom` and `extract_alpha`, written as ideal states.

## Ideal State

- A reader who has two minutes gets the specific ideas, quotes and contrarian takes that make this piece worth their time, in sections named for this content rather than a fixed template.
- Every bullet sounds like the principal telling a friend about it, and every detail comes from this content, never from the calibration samples.
- Contrarian takes are mandatory: a genuinely hot take from the speaker appears undiluted, because spicy takes are the most memorable and shareable material.
- An Alpha run returns exactly the N ideas asked for (24 by default), ranked by how new they are, each short and faithful to the source, or fewer with a note when the content has fewer.
- The structure matches the requested depth level (Full by default) and passes the Quality Check in `Intents/Extract.md` § Output format; the `extractwisdom-contract` eval separately checks that insights come from the source and that a contrarian take appears.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Extract** | "extract wisdom from", `ew`, "analyze this", YouTube URL | `Intents/Extract.md` |
| **Alpha** | "extract alpha", `ea` or `ea 8`, "highest-alpha ideas", "what is new in this" | `Intents/Alpha.md` |

| File | Read when |
|------|-----------|
| `References/VoiceCalibration.md` | writing any bullet: the three-level voice ladder with sample bullets (calibration only) |
| `EvalState.md` | checking the extractwisdom-contract eval results (machine-written by Assay, never hand-edited) |
| `Setup.md` | first-time setup: the optional fabric and yt-dlp install for YouTube links |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ExtractWisdom/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When it exists, its PREFERENCES.md, configurations and resources override the defaults here; when absent, the defaults stand.

First-time setup: [Setup.md](Setup.md).

## Gotchas

- Source fetching (`fabric -y URL` for YouTube, raw HTML for articles) and chunking long transcripts are in `Intents/Extract.md` § Inputs and § Gotchas.

## Examples

**Example 1: YouTube interview extraction**
```
User: "extract wisdom from this Marcus Hutchins interview"
→ Extract intent; transcript from `fabric -y URL`
→ Sections named for this interview, then the closing sections for Full
```

**Example 2: Article extraction**
```
User: "extract the key insights from this blog post"
→ Raw HTML fetched and its body extracted in full (never WebFetch, which returns a summary)
→ Sections adapted to the article, with source attribution
```
