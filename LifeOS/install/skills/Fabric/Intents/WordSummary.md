# WordSummary

Anything (a topic, a question, a URL, a video, a file, pasted text, or the conversation) told at N depths, from N words down to one, where every line is the whole truth of the subject at that size.

Our ideal-state port of Fabric's `create_5_sentence_summary`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The levels deliver what the principal actually wants from this input, inferred before a word is written, never asked for and never a literal summary of the words typed. The read follows what the input is: a topic of thought or culture ("russian literature", "stoicism") means what it teaches; an invention or event ("the printing press") means what it changed and why that matters; a person means what to learn from them; a source means its point; a question means its answer; a tool or product means what it is good for and whether it is good; the conversation means where we landed. A typed hint ("what russian literature teaches us", "the history of") overrides the default read.
- The heading names the read that was inferred ("5 Levels: What Russian Literature Teaches", "3 Levels: Why the Printing Press Mattered"), so a wrong read is visible at a glance.
- The output has exactly N levels. N is the leading whole number in the request (`ws 3` → 3) and defaults to 5. Each level is its own line opening on its number in bold (`**5.**`), counting down from N to 1, and the level numbered k holds exactly k words, counted as `Tools/WordSummaryCheck.ts` counts them (whitespace-separated; a hyphenated compound or a number is one word).
- Each level stands alone: a reader who sees only that line gets the essence of the subject at that size, as a complete thought in its own right.
- Each level reframes rather than trims. A smaller level finds the better way to say the whole thing in fewer words. It is never the level above with words deleted, so no level's words appear in order inside the level above it.
- The one-word level is the single word that someone who knows the subject deeply would pick as its core, and the levels above it build toward that word.
- Every level is specific to this subject. A line that would fit most other subjects as well ("Complex ideas worth exploring") fails, and so does a line built from generic filler. The small levels are where this is hardest and matters most: the two-word and one-word levels name what this subject owns more than its nearest neighbors do (for Russian literature, a word such as "toska" over "conscience", which fits any literature).
- A summary of a source says what the source says about its own case. It never turns the source into a general lesson the source does not draw ("Density pays" from one city's rents is a claim the text never made).
- When the input asks a question, every level answers it. When the input is a source, the levels capture what that source actually says, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs). When the input is a bare topic, every level carries the inferred read (first criterion) at the level of insight an expert would sign, never a description of what the topic is, covers or contains.
- The words are plain and exact: the most precise ordinary word wins over jargon, and a word is spent on meaning, never on padding to hit the count.
- When the input is a URL or text of 200 characters or more, the summarize-family Harvest side effect in `Intents/ExecutePattern.md` § Tool contract fired on the same input, and its result block (or its error, as a warning) follows the levels after a blank line and a `--- HARVEST ---` line. A bare topic, a question or the conversation never fires it.
- `bun skills/Fabric/Tools/WordSummaryCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the counts are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a level whose word count differs from its number, and never a level skipped, repeated or out of order.
- Never truncation posing as a smaller level, such as "Suffering souls seeking moral truth" followed by "Suffering souls seeking truth".
- Never a bare topic answered with a description of it ("Novels argued what tsars forbade", "Superfluous men seeking God") instead of what it teaches ("Suffering, faced honestly, can redeem").
- Never a claim the source does not make, and never a source summarized from its title or a fetched page summary instead of its full text.
- No commentary, caveats, sub-bullets or explanation anywhere. The whole output is the heading and the levels, plus the one cap note when N was capped and the Harvest block when one is due.
- Never markdown ordered-list syntax (`5. text` at the start of a line): renderers renumber a list that starts at 5 as 5, 6, 7, so a countdown displays backwards.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-wordsummary — code checks on shape and count, plus judged checks on standalone meaning, reframing, specificity and the one-word level.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- An optional leading whole number N from 1 to 24 (larger asks are capped at 24, and the output says so in one line after the levels).
- The subject: a topic, a question, a URL, a YouTube link, a file path, pasted text, or "this"/"that" or nothing at all, which means the current conversation's subject.

## Tool contract

Fetching a URL or a YouTube transcript, and the summarize-family Harvest trigger, follow `Intents/ExecutePattern.md` § Tool contract. Run from `~/.claude`. Save the draft (without the Harvest block), check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/WordSummaryCheck.ts <file|-> [--levels N] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; --levels pins the expected N
```

## Output format

```markdown
**{N} Levels: {the inferred read, e.g. What Russian Literature Teaches}**

**{N}.** {exactly N words}

**{N-1}.** {exactly N-1 words}

…

**1.** {one word}
```

## References

- Upstream: `Patterns/create_5_sentence_summary/system.md` (fixed at five levels, five words to one, as a descending numbered list that markdown renumbers).
- `Tools/WordSummaryCheck.help.md`: the checker's rules and exit codes.
