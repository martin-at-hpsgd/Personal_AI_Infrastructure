# AnalyzePaperCheck

Checks an AnalyzePaper output (`Intents/AnalyzePaper.md`) against the parts of its contract that code can judge, in the mode it was written for. Whether each item is faithful to the paper, specific and fairly graded stays a judged check in the `fabric-analyzepaper` suite.

## Usage

```bash
bun skills/Fabric/Tools/AnalyzePaperCheck.ts <file|-> [--mode full|summary|brief] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--mode` | `full` (default, `analyze_paper`), `summary` (`summarize_paper`) or `brief` (`analyze_paper_simple`) |
| `--json` | Print `{ok, mode, scores, grade, problems}` |
| `--help` | Print usage |

## Checks

Full mode:

- The first line is `# Paper Analysis: <title>`, optionally followed by one `Source:` line, then exactly SUMMARY, AUTHORS, AUTHOR ORGANIZATIONS, FINDINGS, STUDY OVERVIEW, STUDY QUALITY, CONFLICTS OF INTEREST, RESEARCHER'S INTERPRETATION, PAPER QUALITY, FINAL GRADE and SUMMARY STATEMENT as `##` sections in that order.
- SUMMARY is one sentence of at most 25 words; RESEARCHER'S INTERPRETATION one sentence of at most 30. Abbreviations such as "et al." or "U.S." do not count as sentence breaks.
- FINDINGS holds 1 to 10 `- ` items of at most 30 words; STUDY OVERVIEW 1 to 10 of at most 35; no item repeats within a section.
- STUDY QUALITY holds exactly nine items opening `Study design:`, `Sample size:`, `Confidence intervals:`, `P-values:`, `Effect size:`, `Consistency of results:`, `Methodology transparency:`, `Reproducibility:`, `Data analysis method:`, in that order, each non-empty and at most 40 words.
- CONFLICTS OF INTEREST is one line opening on NONE DETECTED, LOW, MEDIUM, HIGH or CRITICAL, then a dash and the reason.
- PAPER QUALITY holds `- Novelty: n/10 — reason`, `- Rigor: n/10 — reason`, `- Empiricism: n/10 — reason` with n from 1 to 10, then a fenced chart of three rows (`Known … Novel`, `Weak … Rigorous`, `Theoretical … Empirical`) whose bar is n−1 dashes, the number, and 10−n dashes for its score. A bar off by a cell fails.
- FINAL GRADE is two lines: a letter A, B, C, D or F with an optional + or −, then a reason of at most 30 words.
- An A grade fails beside a Rigor below 7 or a conflict rating of MEDIUM, HIGH or CRITICAL.
- SUMMARY STATEMENT opens on one sentence of at most 35 words, then exactly five `- ` bullets of at most 15 words.
- No bold or italics, no numbered lists, no code fence except the chart, and no code fence wrapping the whole output.

Summary mode:

- Exactly the seven headers `## Title and Authors`, `## Main Goal and Fundamental Concept`, `## Technical Approach`, `## Distinctive Features`, `## Experimental Setup and Results`, `## Advantages and Limitations`, `## Conclusion`, in order, each with content; nothing before the first header and no other header. Markdown emphasis is allowed.

Brief mode:

- Exactly eight lines, `- TITLE:`, `- SUMMARY:`, `- IMPLICATIONS:`, `- RECOMMENDATION:`, `- AUTHORS:`, `- METHODOLOGY:`, `- CONFLICT/BIAS:`, `- REPRODUCIBILITY:` in that order. SUMMARY is at most 20 words, the next five at most 40, and REPRODUCIBILITY reads `n/5 — reason` with n from 1 to 5 and a reason of at most 20 words. No bold or italics, no numbered lists.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
