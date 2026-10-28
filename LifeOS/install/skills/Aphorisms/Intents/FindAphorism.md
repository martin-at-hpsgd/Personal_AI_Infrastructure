# Find Aphorism for Newsletter Content

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples · References

3-5 ranked, attributed, fresh aphorism recommendations for a newsletter edition (usually the recurring quote named in PREFERENCES.md § Default use), each matched to the edition's themes and tone with the reason it fits.

## Ideal State

- A content analysis in the Analysis Output shape sits above the recommendations and was written before any quote was matched: core topic, emotional tone, the 2-3 key messages, the TELOS themes present, and the audience. It is built from the edition itself: the article text `Aphorisms.ts fetch` returns for a URL, the full pasted text, or the themes the request lists; when a URL yields no text, the reply asks for the pasted text or themes instead of analysing a summary.
- The TELOS themes in the analysis come from the list in PREFERENCES.md § Philosophy themes, or when it has none, the themes the edition itself carries, named plainly and marked as drawn from the content rather than from a configured list. They describe the content and are separate from the database's theme categories. The audience line describes the newsletter's readers as PREFERENCES.md § Default use names them.
- Each candidate is scored 0-10 on thematic relevance, tonal alignment, message reinforcement, philosophical alignment and freshness (total out of 50), using the Matching Criteria in Output format.
- The reply holds 3-5 recommendations, ranked by score. Each one shows its full quote, author, a specific why-this-fits on each of the four fit criteria, a placement suggestion with its reason, context when readers might need it, and its score.
- Every recommendation scores at least 35/50. A recommendation below 35 appears only when nothing better exists after the fallback order in References (widen, then research, then the higher-level TELOS themes), and the reply says it is below the bar.
- Candidates come from the database, read in full. When it cannot supply three at the bar, the search first widens to adjacent themes; if that still falls short, new quotes are researched (`Intents/ResearchThinker.md`) and added through `Intents/AddAphorism.md` before they are recommended, so every pick ends up in the database.
- When the request names recent Synapse captures as the source, the candidates are quotes found in those captures over the window the request names. Each is verified and attributed like any other candidate, and the reply names the capture it came from.
- Every recommended quote is verified in text and attribution and is not a quote with a recent recorded use in the Newsletter Usage History (what counts as a use: SKILL.md § Database). When the history has no record for a quote, its freshness score says so.
- The set varies its authors, balances well-known and lesser-known quotes, and mixes classical and contemporary thinkers. It accounts for the time of year, current events and recent newsletter themes. With several drafts, all are analysed together and the picks span their shared themes with variety across them.
- The delivered set is recorded in the same turn it is delivered: one run in the database's Newsletter Usage History in the format in SKILL.md § Database (date, edition, every recommended quote, `Selected: pending`), and `Aphorisms.ts check --history-since <today>` exits 0. When the user names the pick, in this session or a later one, that run's Selected line is set to it with its placement. The record never waits on a selection.

## Anti-criteria

- Fewer than 3 recommendations are never delivered.
- No recommended quote has a jarring tonal mismatch with the newsletter, and no selection is tone-deaf to current events.
- No recommendation's TELOS philosophy alignment is claimed where it is not genuine.

## Inputs

The newsletter edition as a URL, pasted text, or a list of its themes (the usual request form, when PREFERENCES.md § Default use names one), or a request to draw candidates from recent Synapse captures (the amber ledger, `LIFEOS/DOCUMENTATION/Synapse/SynapseSystem.md`).

## Tool contract

A URL is read from its raw HTML, never through WebFetch, which returns a small model's summary rather than the edition's text. Run from `~/.claude`:

```bash
bun skills/Aphorisms/Tools/Aphorisms.ts fetch <url>                         # title + article text; exit 3 when nothing came back
bun skills/Aphorisms/Tools/Aphorisms.ts check --history-since <YYYY-MM-DD>  # after writing the run; exit 1 when no run on or after that date
```

### Intent-to-Flag Mapping

| Need | Command |
|---|---|
| The edition is a URL | `fetch <url>` |
| Prove the delivered set was recorded | `check --history-since <today>` |
| Confirm the collection is consistent after research or adds | `check` |

## Output format

**Analysis Output:**
```markdown
### Content Analysis
- **Core Topic**: [Topic]
- **Emotional Tone**: [Tone]
- **Key Messages**:
  1. [Message 1]
  2. [Message 2]
  3. [Message 3]
- **TELOS Themes**: [Theme 1], [Theme 2], [Theme 3]
- **Audience**: [Context]
```

**Matching Criteria:**

1. **Thematic Relevance** (0-10): strong connection to the core themes 8-10, tangential 4-7, weak 0-3.
2. **Tonal Alignment** (0-10): perfect match 8-10, compatible 5-7, mismatched 0-4.
3. **Message Reinforcement** (0-10): strongly reinforces a key message 8-10, somewhat supports 4-7, neutral or contradictory 0-3.
4. **Philosophical Alignment** (0-10): embodies TELOS philosophy deeply 8-10, some alignment 5-7, misaligned 0-4.
5. **Freshness** (0-10): not used recently 10, used 6+ months ago 7-9, used within 6 months 3-6, used within 3 months 0-2.

**Total Score:** Sum of all criteria (max 50)

**Format for Each Recommendation:**

```markdown
### Recommendation [N]: [Quote Summary]

**Quote:**
"[Full quote text]"

**Author:** [Author Name]

**Why This Fits:**
- **Thematic Relevance**: [Specific connection to newsletter themes]
- **Tonal Alignment**: [How mood/style matches]
- **Message Support**: [Which key message it reinforces]
- **TELOS Alignment**: [Which philosophy themes it embodies]

**Placement Suggestion:**
[Opening quote / Closing quote / Section divider] - [Reasoning]

**Context (if needed):**
[Brief background on quote or author if readers might need it]

**Score:** [X/50]
```

Recommendations are numbered by total score, highest first. The Quick Decision Guide names, for each one, the situation it suits best (maximum impact, a recently used author, broad appeal, surprise, philosophical depth), read off that quote rather than off its rank.

**Summary Format:**

```markdown
## Aphorism Recommendations for "[Newsletter Title/Theme]"

### Content Analysis Summary
[Brief 2-3 sentence summary of themes and tone]

### Top Recommendations

[Every recommendation, in the Format for Each Recommendation shape]

### Quick Decision Guide
- **[When to choose it]**: Recommendation #[N]
[One line per recommendation]
```

## Examples

**User:** "I'm writing a newsletter about how major security breaches happen from ignoring basic security hygiene. Find me a good aphorism."

```markdown
### Content Analysis
- **Core Topic**: Security fundamentals, basics matter
- **Emotional Tone**: Cautionary, frustrated, emphasizing fundamentals
- **Key Messages**:
  1. Basics matter more than advanced techniques
  2. Ignoring fundamentals leads to failure
  3. Excellence requires discipline on basics
- **TELOS Themes**: Excellence & Mastery, Discipline, Learning (back to basics)
- **Audience**: Security professionals, technical readers
```

Matches from Work Ethic & Excellence and Learning & Education: Tim Grover (hard work = results) 38/50, Muhammad Ali (suffer now = champion) 37/50, Confucius (learning + thinking) 35/50. The first, in full:

```markdown
### Recommendation #1: Focus on What Matters (Tim Grover)

**Quote:**
"You don't have to love the hard work. You just have to crave the result so intensely that the hard work becomes irrelevant."

**Author:** Tim Grover

**Why This Fits:**
- **Thematic Relevance**: Security hygiene IS hard work - tedious, unglamorous, but critical
- **Tonal Alignment**: Uncompromising, results-focused matches newsletter's emphasis on fundamentals
- **Message Support**: Reinforces "basics matter" - the "hard work" IS the basics
- **TELOS Alignment**: Excellence through discipline, results > effort

**Placement Suggestion:**
Opening quote - Sets tone that security fundamentals are non-negotiable hard work

**Score:** 38/50
```

The set goes into the Newsletter Usage History as one run with `Selected: pending`; when the user picks the Tim Grover quote, that run's Selected line names it as the opening quote.

## References

- No strong match, in this order: (1) widen to adjacent themes (resilience → strength → adversity) and consider complementary rather than identical matches; (2) research new quotes through `Intents/ResearchThinker.md` and add them through `Intents/AddAphorism.md` before recommending them; (3) match on the higher-level philosophy themes in PREFERENCES.md § Philosophy themes (or, with none configured, the themes the edition carries), recommending quotes that align philosophically even when not directly on topic.
- Rejected recommendations: ask what missed (tone, author, message), then offer new ones or research a specific thinker or theme on demand.
- Multi-themed content: recommend one quote for the dominant theme, or one quote that unifies the themes (a newsletter on "AI safety through careful engineering": Marcus Aurelius on control and wisdom).
- `Intents/SearchAphorisms.md` explores the database by theme before analysis.
