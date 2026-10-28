# ExtractAlpha

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples · References

The highest-alpha ideas in a piece of content: what is genuinely new, counterintuitive and profound, as a short list of approachable bullets saved to research history.

## Ideal State

- A deep analysis of the content across all 10 dimensions (surface scan, depth probe, connection map, assumption challenge, novelty detection, framework extraction, subtle insights, contrarian angles, future implications, synthesis) existed before any insight was extracted.
- The output is the highest-alpha insights in the Output format, at the count and bullet style set in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Research/PREFERENCES.md` § ExtractAlpha when that file sets them, else up to 30 insights, each one plain-language sentence a reader gets on first pass; when the content holds fewer truly novel insights, the list is shorter rather than padded, since 15 brilliant insights beat 30 padded ones.
- Every insight is something genuinely new, on the principle that real information is what's different, not what's the same: it meets at least one HIGH-ALPHA signal under Output format, and specific details appear only when they sharpen the surprise.
- Every important surprising idea in the content that meets a HIGH-ALPHA signal under Output format appears in the output, including subtle observations the reader almost missed.
- Working artifacts (raw transcripts from fabric -y, intermediate notes, deep thinking working thoughts, draft insights) sit in `~/.claude/LIFEOS/MEMORY/WORK/<slug>/` for the current ISA's slug, or a dated kebab slug with no ISA, created with `mkdir -p` before anything was written, and they stay there tied to the work item.
- The permanent history directory `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM-DD_description/` holds `extract_alpha.md` (the final insights), `deep-thinking-analysis.md` (the full analysis, all 10 dimensions), `README.md` from the template and `metadata.json`, written by this intent and confirmed by listing the directory.

## Anti-criteria

- No mode collapse (only high-probability obvious ideas), surface skimming (missing depth for breadth), quote collection (restating without extracting insight), comprehensiveness trap (capturing everything instead of the highest alpha), rigid formatting (forcing a word count when a few more words would be clearer), or obvious takeaways (main points instead of surprising implications).
- No padding with obvious ideas, and no LOW-ALPHA signal from the Output format list in the extraction.
- Working files never land in the current directory, and they are not deleted when the run ends.

## Inputs

YouTube videos, podcasts, interviews, essays, articles and blog posts, when the ask is "extract alpha", "deep analysis" or "extract the most important ideas", or when standard patterns missed the key insights in dense content.

## Tool contract

Content comes from `fabric -y` for YouTube, WebFetch for articles, a direct paste, or a file. The slug is the current ISA's slug (its frontmatter `slug:`, the directory name under `LIFEOS/MEMORY/WORK/`); with no ISA, use `$(date +%Y%m%d)-<kebab-topic>`.

```bash
SLUG="<current ISA slug, or $(date +%Y%m%d)-podcast-analysis>"
WORK_DIR="$HOME/.claude/LIFEOS/MEMORY/WORK/$SLUG"
mkdir -p "$WORK_DIR" && cd "$WORK_DIR"
fabric -y "YOUTUBE_URL" > raw-transcript.txt

mkdir -p ~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM-DD_description/
ls -lah ~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM-DD_description/
# Should show: README.md, extract_alpha.md, deep-thinking-analysis.md, metadata.json
```

**Optional verification:** for insights with quantitative claims, spot-check via `Intents/Verify.md` Tier 2.

## Gotchas

**Nothing saves this output for you.** No hook writes to `MEMORY/RESEARCH/`; the files exist only if this intent writes them.

## Output format

Simple markdown list with blank lines between items for readability:

```markdown
# EXTRACT ALPHA

- First high-alpha insight in approachable style

- Second surprising idea that challenges assumptions

- Novel framework or mental model discovered

- Non-obvious connection between concepts

- Counterintuitive observation with implications

- Subtle but profound philosophical point

[... continue up to the configured count ...]
```

### HIGH-ALPHA SIGNALS:
- Makes you stop and reconsider something you thought you knew ("wait, WHAT?")
- Connects ideas from different domains unexpectedly (the same principle across human/AI, biology/ML)
- Challenges industry consensus or common wisdom
- Reframes a familiar concept in a surprising way
- Has second-order implications not explicitly stated
- Feels counterintuitive but makes sense upon reflection
- Represents a novel mental model or framework
- Captures a subtle observation with profound weight
- Feels personally relevant or changes how you see yourself
- Makes you want to tell someone else

### LOW-ALPHA SIGNALS (avoid):
- Restates common knowledge
- Obvious implications or direct quotes of main points
- Generic advice that could apply to anything
- Surface-level observations without depth
- Ideas you've heard many times before
- Purely factual information without insight

**Example work item structure:**
```
~/.claude/LIFEOS/MEMORY/WORK/{slug}/
├── raw-transcript.txt
├── deep-thinking-notes.md
├── draft-insights.md
└── working-analysis.md
```

**Example history structure** (metadata.json holds URL, title, date analyzed, content type):
```
~/.claude/LIFEOS/MEMORY/RESEARCH/2025-10-26_podcast-analysis/
├── README.md                  # Research session documentation
├── extract_alpha.md           # Final insights
├── deep-thinking-analysis.md     # Full deep analysis
└── metadata.json              # Source info, timestamps, etc.
```

The README.md in the history directory:

```markdown
# Extract Alpha - [Content Title]

## Source Information
- **URL/Title:** [Source URL or title]
- **Content Type:** [YouTube video / Article / Podcast / Essay]
- **Date Analyzed:** YYYY-MM-DD
- **Analysis Duration:** [Time spent]

## Analysis Method
- deep thinking Deep Analysis (10-dimension framework)
- Focus on low-probability but brilliant insights

## Key Findings Summary
[2-3 sentence summary of the most important insights discovered]

## Output Files
- `extract_alpha.md` - Final highest-alpha insights
- `deep-thinking-analysis.md` - Complete deep thinking analysis
- `metadata.json` - Structured source and analysis metadata

## Notes
[Any important observations about the analysis process or content]
```

## Examples

Insights a standard extract_alpha pass might miss in a podcast on AI (transcript from `fabric -y "https://youtu.be/VIDEO_ID"`), all of which this intent should capture:
- "We're not building animals, we're building ghosts" (profound reframing)
- "Pre-training is like crappy evolution" (novel framework)
- "Context window is working memory, weights are hazy recollection" (powerful analogy)
- "In-context learning might implement gradient descent internally" (deep technical insight)
- "Agents are trying to get the full thing too early" (historical pattern observation)

## References

How this differs from the Fabric patterns: extract_wisdom covers breadth in structured 16-word bullets (IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES) and can miss subtle depth; the original extract_alpha gives 24 items of 8-word bullets and can miss ideas through mode collapse. This intent runs the deep analysis first and favors low-probability but brilliant insights over comprehensiveness.
