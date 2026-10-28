# AnalyzeProseCheck

Checks an AnalyzeProse output (`Intents/AnalyzeProse.md`) against the parts of its contract that code can judge. Whether each grade is earned, each finding is specific to the text, and each rewrite is better stays a judged check in the `fabric-analyzeprose` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzeProseCheck.ts <file|-> [--mode ratings|pinker] [--source <text-file>] [--max-words N] [--sections <list>] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--mode M` | Pin the mode; by default it is read from the title (`# Prose Analysis:` is ratings, `# Sense of Style:` is Pinker) |
| `--source F` | The supplied text: every quotation of six or more words must appear in it, no `**Source:**` line is allowed, and the minimum counts and word budget follow its length |
| `--max-words N` | Cap the output at N words, overriding the budget |
| `--sections L` | The sections a hint asked for, as a comma list. Ratings: `novelty, clarity, prose, recommendations, overall`. Pinker: `style, positive, critical, examples, spelling, improvements, scoring` |
| `--json` | Print `{ok, mode, sections, words, budget, problems}` |
| `--help` | Print usage |

## Checks

Both modes:

- One H1 title, first in the output, opening on `# Prose Analysis: ` or `# Sense of Style: ` and naming the text.
- Between the title and the first section, only a `**Source:**` line (when no text was supplied) and then an `**Answer:**` line (when the request asked a question).
- The mode's sections, or the hinted subset, in canonical order, none empty.
- With `--source`, every double-quoted span of six or more words before any `→` rewrite appears in the source word for word (punctuation, case and apostrophes ignored; `…` and `[insertions]` split a quote into fragments). Shorter quoted spans are taken as suggested wording ("use", "you") and are not checked; the judged suite covers short misquotes.
- The output fits its word budget, headings excluded. Ratings: 400 words for a text under 150 words, 500 under 600, 600 beyond, 500 with no text. Pinker: 1100, 1500, 1800, and 1500 with no text.

Ratings mode (`Novelty`, `Clarity`, `Prose`, `Recommendations`, `Overall rating`):

- Each graded section opens on `**Rating:** <letter> - <label>`, with the label from that dimension's scale (Novelty: Novel, Fresh, Incremental, Derivative, Stale; Clarity: Crystal, Clean, Kludgy, Confusing, Chaotic; Prose: Inspired, Distinctive, Standard, Stale, Weak, for A, B, C, D, F), and a reason under it. When a text was supplied, Clarity and Prose quote it.
- Recommendations are bullets opening on the grade they raise (`- **Clarity:** …`), at most 9, each at most 30 words. Every grade below A has at least one. Clarity and Prose recommendations quote the text when there is one.
- Overall rating is a single letter equal to the lowest of the three grades.

Pinker mode (`Style analysis`, `Positive assessment`, `Critical assessment`, `Examples`, `Spelling and grammar`, `Improvement recommendations`, `Scoring`):

- Style analysis has 2 to 5 bullets (3 to 5 for a text of 150 words or more) and names at least one of Pinker's styles: classic, practical, self-conscious, postmodern, academic, legal.
- Positive assessment scores each of the ten qualities once as `- **Quality:** N/10 — reason`, then a `**Weighted:** X/10` line equal (to 0.1) to the importance-weighted mean: Clarity 10, Brevity 8, Elegance 7, Coherence 9, Directness 8, Vividness 7, Honesty 9, Variety 6, Precision 9, Consistency 7.
- Critical assessment holds the legend line (any line opening on "Score" that mentions avoiding), at least one `- **Pitfall:** N/10 — …` bullet naming one of Pinker's 25 pitfalls (short forms such as "Jargon" or "Hedge" match) with an avoidance score of 1 to 9 and a quoted instance, and at most one `**Avoided:**` line.
- Examples holds `- **Good:**` and `- **Bad:**` bullets, each quoting the text, 1 to 5 of each (3 to 5 for a text of 150 words or more).
- Spelling and grammar is the single line `None found.` or bullets that quote the error and give the fix after `→`.
- Improvement recommendations has 2 to 10 bullets (5 to 10 with a source of 150 words or more), each quoting the passage and giving the rewrite after `→`.
- Scoring opens on `Starting score: 100`, lists deductions as `- −N for <reason>`, gives `Final score: X` equal to 100 minus the deductions and inside 0 to 100, and ends on an overall assessment of 2 to 3 sentences and at most 200 words.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
