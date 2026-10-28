# ExplainFundamentals

A deep, current explanation of the fundamentals of one area the principal works in: a project, a work stream, or a piece of technical infrastructure. It covers what the area is for, the parts it cannot lose, how those parts hold each other up, and what has changed lately. Shortcut: `/ef [area]`.

## Ideal State

- The area is the one the principal meant. A named argument wins; with none, it is the area this conversation has been working in. Names resolve through the projects routing table and the system's own context sources, never by guessing a path. When two areas are plausible, the intent asks one "X, or Y?" question first.
- Every fundamental comes from a source read this session: the area's projects-table row, its ISA (the `## Ideal State` ladder especially), its architecture or system doc, its code entry points and layout, its recent commit history, and its deploy and monitoring state where those exist. Each fundamental names the source it came from. Anything not verified this session is marked unverified in the same sentence.
- A part counts as a fundamental only if it passes one test, applied fresh to each candidate: finish the sentence "Without X, <area> can no longer ___." If the blank is a job the area exists to do, X is fundamental. If the only honest blanks are look, feel, notify or be convenient, X is quality of life. Quality-of-life parts get one closing line, never a slot in the set. The count comes from the area, usually 4 to 9.
- It opens on the whole. The first paragraph says what the area is for, who or what depends on it, and how its fundamentals hold each other up, in the principal's register.
- Each fundamental gets: what it is in plain words, the job it does, at least one other fundamental it feeds or depends on and what passes between them, and the fact about it that is easiest to forget or get wrong. A technical term is explained the first time it appears.
- The structure is drawn. One `flow` diagram shows the fundamentals and what passes between them. A table appears wherever the parts carry attributes worth comparing (where it runs, what it costs, its current health), and status cells carry a mark (✅ ⚠️ ❌).
- It tells the area's real current state, broken parts included. A "What changed" section names the changes since the principal last explained or quizzed this area (from the learning record), or over the last 30 days when there is no record. Only changes that moved a fundamental count, never commit churn.
- It is thorough by default, because the point is depth. A shape word in the argument (`short`, `deep`, `for <audience>`) changes the length; the fundamentals set and its order stay the same.
- The fundamentals set lands on the learning record at the end of the run (Tool contract), so QuizFundamentals tests the set the principal was taught.
- When the area is LifeOS itself and the `lc` intent is installed, the ratified fundamentals set behind `lc` is the starting spine, so the two never keep separate lists.

## Anti-criteria

- No fundamental stated from memory, from a summary of an earlier session, or from a page summarizer.
- Never a file-by-file tour or a list of every component. A part that fails the test is not dressed up as a fundamental.
- Never a secret value, credential, token or `.env` content, in the explanation or on the record.
- Read-only. It never edits the area's code, ISA, docs or config. The learning record is its only write.
- It does not end on an offer or a manufactured next step. When the fundamentals are covered, it stops.

## Inputs

- `$ARGUMENTS`: the area, plus an optional shape word. Empty means the conversation's area; on a fresh session with nothing in play, the intent asks which area.

## Tool contract

Run from the LifeOS root (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when set).

```bash
bun LIFEOS/TOOLS/SystemContext.ts load projects                # resolve the area's name, path and deploy command
bun LIFEOS/TOOLS/SystemContext.ts search "<area>"              # architecture docs and skills that name it
bun LIFEOS/STATVS/Statvs.ts tail --stream learning --n 500     # past explain and quiz rows; filter by data.area
```

Record the set once, after the explanation is written:

```bash
bun LIFEOS/STATVS/Statvs.ts append --writer explain --stream learning --kind explain \
  --title "<area>" --data '{"area":"<area-slug>","fundamentals":["<name>",...],"sources":["<path or URL>",...],"head":"<git short sha or null>"}'
```

`area-slug` is lowercase with hyphens and stays the same across runs, because QuizFundamentals filters on it.

## Output format

1. 🎯 line with the area's one-sentence point.
2. The opening paragraph on the whole.
3. The `flow` diagram.
4. One section per fundamental, in order of how much the others depend on it.
5. A table where the parts carry attributes.
6. `What changed`, then one line for the quality-of-life layer.
