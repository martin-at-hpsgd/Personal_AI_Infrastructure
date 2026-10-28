# InterviewExtraction

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Gotchas · Examples · References

Standardized insights extracted from interviews and notes into 13 categorized output files.

## Ideal State

- Every text-based file in the directory tree (`.md`, `.txt` and similar, found recursively) is processed in full: no file skipped, no content truncated, edge cases and subtle mentions captured. An unreadable file is skipped with a warning while processing continues, and the file inventory was reported before analysis.
- 13 output files, one per extraction category, exist at the top level of the target directory, each in the Output File Template shape; a category with no extractions still gets its file with "No items extracted for this category".
- Every extracted item has source file attribution, including the speaker name when identifiable; semantically similar items are consolidated into the most complete/clear version while preserving all source attributions, and for duplicates every source is listed.
- Each item quotes the source's original phrasing wherever the wording is meaningful, never an over-summarizing paraphrase that drops a qualifier or nuance the source stated, and carries the surrounding context wherever the item would be misread without it (context where critical).
- Within each category, items are ordered by significance: items mentioned multiple times ranked higher, items with stronger language ranked higher, critical/urgent items prioritized.
- After all files are generated, a summary report gives files processed, output location, category counts and notable patterns.

## Anti-criteria

- No customer data in this intent file: all extraction happens at runtime and output files contain extracted content only.
- No extracted item without source file attribution.
- No skipped files or truncated content, other than an unreadable file skipped with a warning.

## Output format

### Extraction Categories (13 Total)

| Category | Description | Output File |
|----------|-------------|-------------|
| Differentiators | What makes this entity unique, competitive advantages, special capabilities | `DIFFERENTIATORS.md` |
| Findings | General discoveries, observations, and insights | `FINDINGS.md` |
| Complaints | Issues people are unhappy about, frustrations, pain points | `COMPLAINTS.md` |
| Gaps | Things that are missing, unmet needs, absent capabilities | `GAPS.md` |
| Critical Issues | Urgent problems requiring immediate attention | `CRITICAL_ISSUES.md` |
| Blockers | Theory of Constraints friction points preventing progress | `BLOCKERS.md` |
| Ideas | Suggestions, potential solutions, creative proposals | `IDEAS.md` |
| Recommendations | Actionable advice, specific guidance given | `RECOMMENDATIONS.md` |
| Architecture | System structure, organizational design, how pieces fit together | `ARCHITECTURE.md` |
| Vision | What the entity should/wants to become, aspirational state | `VISION.md` |
| Tech Stack | Technologies, tools, platforms, and systems mentioned | `TECH_STACK.md` |
| Metrics | Quantitative measures, KPIs, numbers, statistics | `METRICS.md` |
| Goals | Objectives, targets, desired outcomes | `GOALS.md` |

File inventory, reported before analysis:

```
Found X interview files across Y directories:
- [list files with paths]
```

The 13 output files go at the **top level** of the target directory.

**Output File Template:**

```markdown
# [CATEGORY NAME]

*Extracted from interviews and notes. Each item includes source attribution.*

---

## Items

- [Extracted item - preserve original phrasing where possible] — *Source: [filename.md], [Speaker Name if known]*

- [Another extracted item] — *Source: [filename.md]*

- [Item mentioned by multiple sources] — *Sources: [file1.md] (Speaker A), [file2.md] (Speaker B)*

---

*Generated: [timestamp]*
*Files processed: [count]*
```

Summary, after all files are generated:

```markdown
## Extraction Complete

**Files Processed:** X
**Output Location:** [target directory]

### Category Counts
| Category | Items Extracted |
|----------|-----------------|
| Differentiators | X |
| Findings | X |
| Complaints | X |
| Gaps | X |
| Critical Issues | X |
| Blockers | X |
| Ideas | X |
| Recommendations | X |
| Architecture | X |
| Vision | X |
| Tech Stack | X |
| Metrics | X |
| Goals | X |

### Notable Patterns
- [Any cross-cutting themes observed]
- [Frequently mentioned items]
- [High-priority items requiring attention]
```

## Inputs

- **Target Directory**: A directory containing interview notes, transcripts, or meeting notes
- **Supported Formats**: Markdown (.md), text (.txt), or similar text-based files
- **Structure**: Files may be organized in subdirectories (e.g., per interview, per date, per person)

## Gotchas

- **Empty Directory**: Report "No interview files found" and exit

## Examples

```
User: "Extract content from /path/to/interviews"

→ File inventory (15 interview files) reported first
→ 13 category files at /path/to/interviews/, every item attributed to its source file
→ Summary with category counts and notable patterns
```

## References

Feeds the other project intents: CreateNarrativePoints and WriteReport draw their evidence from these category files (Blockers for Theory of Constraints analysis, Vision and Goals for strategic direction, Metrics for the measurement framework).
