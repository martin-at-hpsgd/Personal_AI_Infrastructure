# Research Thinker Quotes

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples · References

A thinker's best verified, TELOS-aligned quotes, each with source and context, filed by theme into the aphorism database and reported to the user.

## Ideal State

- The batch is about one target: one of the key thinkers in PREFERENCES.md or a user-named author, with the theme focus the user gave and the quote count asked for (default the 10-15 best).
- Every added quote has a primary-source attribution (a book, speech, lecture, interview or letter), cross-referenced across sources, or it is marked Disputed. Quote-collection sites (Goodreads, BrainyQuote, WikiQuote) count only as leads.
- The batch is the strongest of a much larger candidate pool (roughly 30-50 for a 10-15 batch). Every quote stands alone without long context, is clear without specialized knowledge, and embodies at least one of the philosophy themes in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/PREFERENCES.md` § Philosophy themes (with no PREFERENCES.md, the themes the user names for the batch).
- No quote is redundant with one already in the database. The batch spans several themes and represents the thinker's philosophy as a whole.
- Every quote has context: its source (book with chapter and page when available, speech or lecture title and date, interview source and date), its background (what the thinker was addressing and why it matters) and its relevance (how it applies to the audience and modern life, and its TELOS connection).
- The quotes are grouped under the thinker's section by primary theme, using only the categories in SKILL.md § Taxonomy, and ordered within each theme by impact, chronology or source order. Each is in the entry format in SKILL.md § Database.
- The placeholder in the thinker's section is replaced with the organized quotes, and the Theme Index adds the thinker under every theme the batch uses, so FindAphorism and SearchAphorisms find the quotes immediately.
- The user receives the research report: total quotes added, counts by theme, the top 3 quotes with why each is notable, a philosophy summary, the TELOS alignment, best use cases, and the database stats.

## Anti-criteria

- No quote fails the Authenticity check and reaches the database as authentic: when in doubt it is marked "Disputed" or skipped, and no misattribution is added.

## Inputs

- **Thinker Name**: one of the key thinkers or a user-specified author.
- **Theme Focus** (optional): e.g. "Feynman on doubt".
- **Quote Count** (optional): default 10-15 best quotes.

**Key thinkers:** the table of thinkers, their focus and priority sources in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms/PREFERENCES.md` § Key thinkers, read before research starts. With no PREFERENCES.md, every thinker is user-named and the research finds the priority sources.

## Tool contract

Run the Research skill (`Skill("Research")`) with 3-5 parallel researchers (ClaudeResearcher, GeminiResearcher), each on a different source or angle, at standard depth, starting from "[Thinker Name] most impactful quotes on [theme/general]". Interview and lecture transcripts on YouTube come through `fabric -y`.

**Research Queries:**

```
"[Thinker Name] most famous quotes"
"[Thinker Name] on [theme]"
"[Thinker Name] wisdom about [TELOS topic]"
"[Thinker Name] book quotes [Work Title]"
"[Thinker Name] interview quotes"
"best [Thinker Name] aphorisms"
```

**Writing the batch:** the thinker's section is `### [Thinker Name]` holding the placeholder `*Quotes to be added from research*`; the Edit replaces that placeholder with the organized quotes.

## Output format

**Thinker section:**

```markdown
### [Thinker Name]

#### [Theme Category 1]

**"[Quote 1]"**
- Author: [Name]
- Theme: [Themes]
- Context: [Context]

**"[Quote 2]"**
- Author: [Name]
- Theme: [Themes]
- Context: [Context]

#### [Theme Category 2]

[More quotes...]
```

**Summary for User:**

```markdown
## [Thinker Name] Research Complete

**Total Quotes Added:** [N]

**Quotes by Theme:**
- [Theme 1]: [N] quotes
- [Theme 2]: [N] quotes
- [Theme 3]: [N] quotes

**Highlight: Top 3 Quotes**

1. **"[Quote 1]"**
   - Theme: [Theme]
   - Why Notable: [Reason]

2. **"[Quote 2]"**
   - Theme: [Theme]
   - Why Notable: [Reason]

3. **"[Quote 3]"**
   - Theme: [Theme]
   - Why Notable: [Reason]

**Philosophy Summary:**
[2-3 sentences capturing thinker's core philosophy as represented in quotes]

**TELOS Alignment:**
[How this thinker's wisdom aligns with user's philosophy]

**Best Use Cases:**
- Newsletter about [topic] → Quote #X
- Newsletter about [topic] → Quote #Y
- General wisdom → Quote #Z

**Database Stats:**
- Total aphorisms: [N]
- Total from [Thinker]: [N]
- Themes covered: [N]
```

## Examples

A context entry: "What can be asserted without evidence can be dismissed without evidence." Source: Christopher Hitchens, "God Is Not Great" (2007). Background: his burden-of-proof formulation, often called "Hitchens' Razor", core to his skeptical method. Relevance: evaluating AI claims, security threats and market hype on evidence.

**User:** "Research Richard Feynman quotes about curiosity and scientific thinking"

From 45 candidates, 28 verified, 22 TELOS-aligned, 15 selected: Curiosity & Intelligence 5, Learning & Education 4, Wisdom & Truth-Seeking 3 (a new category, used only after the user approved it and it was added to PREFERENCES.md § Approved categories), Risk & Action (experimenting) 3. A quote without a primary source keeps its Disputed mark:

```markdown
### Richard Feynman

#### Curiosity & Intelligence

**"I would rather have questions that can't be answered than answers that can't be questioned."**
- Author: Richard Feynman (Disputed: attribution unverified; no primary source found, consistent with his philosophy)
- Theme: Curiosity & Intelligence, Wisdom & Truth-Seeking
- Context: Feynman's epistemology - doubt enables knowledge growth. Essential for scientific thinking and avoiding dogma.

[14 more quotes...]
```

## References

- `Intents/AddAphorism.md` adds single quotes; research batches feed it.
- Thin results: interviews, debates and speeches are more quotable than books. Older or translated thinkers need modernized language and more context, and idea-dense thinkers need context to land, so pick for explanatory power; per-thinker notes live in PREFERENCES.md § Key thinkers. For a dense or poorly aligned thinker, extract the clearest statements or recommend a better-aligned thinker.
- Too many good quotes: add the top 10-15 now and keep the research notes for a later batch.
