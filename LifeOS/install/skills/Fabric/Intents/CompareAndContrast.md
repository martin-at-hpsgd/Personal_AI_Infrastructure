# CompareAndContrast

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A brief compare-and-contrast of any set of things (products, tools, ideas, people, proposals, options, sources) as one markdown table, items down the left and the dimensions that actually separate them across the top, closed by one line on what they share and one on the difference that matters most.

Our ideal-state port of Fabric's `compare_and_contrast`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The comparison answers what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted list of items ("Rust, Go, Zig") means the differences that matter when choosing between them or telling them apart. A pasted artifact that holds several items (two proposals, three vendor quotes, a spec sheet) means those items compared on the facts the artifact gives. A URL or a file means the items the source describes or weighs, read in full, compared on what the source says. A bare topic naming the items ("stoicism and epicureanism", "SQL vs NoSQL") means the dimensions an expert would use to separate them. A bare topic naming one thing ("Kubernetes") means that thing against the two to four real alternatives a person would weigh it against. A question ("Postgres or SQLite for a single-user desktop app?") means a table built to answer it, with the Key difference line giving the answer. "This" or "that" means the options weighed in the current conversation. A typed hint ("on cost and licensing only", "for a beginner", "just the table") overrides the default read.
- The title names the items and the read that was inferred ("Compare and Contrast: Rust, Go and Zig for Systems Work", "Compare and Contrast: Postgres vs SQLite for a Desktop App"), so a wrong read is visible at a glance.
- The table puts one item per row, with the item's name in the first column, and one dimension per column, as the upstream pattern does. The first header cell names what the items are ("Language", "Proposal", "School").
- The dimensions are the ones on which these items actually differ and that bear on the read: for a choice, what decides it; for ideas, what each holds and denies; for a source, the axes the source itself uses. A column on which every item gets the same answer is not a dimension; that shared ground goes in the In common line.
- Every cell is a short, concrete phrase specific to that item on that dimension: a number, a named mechanism, a named practice or a plain verdict with its reason ("GC pauses, sub-millisecond" over "Good"). Each cell is at most 15 words.
- Every fact is accurate. When the input is a source, every cell comes from what the source actually says (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs), and a dimension the source is silent on for one item reads `Not stated` for that item rather than a guess. A cell says what the source states, in its terms; plain arithmetic on the source's own figures (a yearly total, a difference) is fine, and an inference the source does not state ("email only", "locked in", "faster in emergencies") is not.
- The In common line names what the items genuinely share that is worth knowing, and the Key difference line names the one difference that matters most for the read, in one short sentence each, under 40 words. For a question, the Key difference line answers it.
- The whole output is brief: 2 to 8 items, 3 to 6 dimensions by default, nothing beyond the title, the table and the two closing lines.
- The words are plain and exact: the most precise ordinary word wins over jargon, and a term a non-specialist would not know is replaced or explained in its cell.
- `bun skills/Fabric/Tools/CompareAndContrastCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the comparison. The model takes the default read and the title states it.
- Never items along the top and dimensions down the side, and never a list, prose paragraphs or several tables in place of the one table.
- Never a filler dimension ("Overview", "Description", "Summary", "Notes", "Other") or a column that repeats the same answer for every item.
- Never a vague or placeholder cell ("Good", "Varies", "Depends", "N/A", "TBD", "?", a dash, or empty).
- Never a fact, number or claim the source does not make attributed to it, and never a source compared from its title or a fetched page summary instead of its full text.
- Never false balance: when one item is clearly better on a dimension, its cell says so, and the Key difference line does not hedge to keep every item looking even.
- Never a preamble, a persona, commentary between or after the closing lines, or a methodology note.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-compareandcontrast — code checks on the title, the table shape, the item rows and the two closing lines, plus judged checks on the inferred read, dimensions that actually separate the items, concrete and accurate cells, fidelity to a source, and a Key difference line that answers a question.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted list of items, a pasted artifact holding several items, a URL, a YouTube link, a file path, a bare topic naming one or more things, a question choosing between options, or "this"/"that" for the current conversation.
- An optional hint naming the dimensions, the audience or the purpose of the comparison, which overrides the default read. "Just the table" drops the two closing lines.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/CompareAndContrastCheck.ts <file|-> [--table-only] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
#   --table-only: the request said "just the table", so the two closing lines must be absent
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|---|---|---|
| (default) | none | Title, table and both closing lines required |
| "just the table", "table only" | `--table-only` | The In common and Key difference lines must be absent |
| (checking from code) | `--json` | Prints `{ok, items, dimensions, problems}` |

## Output format

Markdown: one H1 title, one blank line, one GitHub-flavored table, one blank line, then the two closing lines in this order. These are the limits the checker enforces:

- The table has a header row, a separator row, and one body row per item: 2 to 10 items and 2 to 8 dimensions, every row with the same number of cells.
- Item names in the first column are distinct, dimension headers are distinct, and no dimension header is a filler word (Overview, Description, Summary, Notes, Other, Miscellaneous, Details, General, Comments).
- No cell is empty or a placeholder (N/A, TBD, ?, a dash, Varies, Depends), and no cell runs past 15 words. `Not stated` is the one allowed stand-in, for a source that is silent.
- No dimension gives every item the same answer.
- `**In common:**` and `**Key difference:**` each open their own line after the table, each with one sentence of at most 40 words; with `--table-only` both are absent.

```markdown
# Compare and Contrast: {the items, and the read inferred}

| {What the items are} | {Dimension 1} | {Dimension 2} | {Dimension 3} |
|---|---|---|---|
| {Item A} | {short concrete phrase} | {…} | {…} |
| {Item B} | {…} | {…} | {…} |

**In common:** {what the items genuinely share, one sentence}

**Key difference:** {the one difference that matters most for the read, one sentence}
```

## References

- Upstream: `Patterns/compare_and_contrast/system.md` (a brief compare-and-contrast of a list of items as one markdown table, items along the left and topics along the top, with no other guidance).
- `Tools/CompareAndContrastCheck.help.md`: the checker's rules and exit codes.
