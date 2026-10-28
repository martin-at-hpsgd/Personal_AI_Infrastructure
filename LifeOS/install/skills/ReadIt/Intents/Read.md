# Read

Turn a piece of content into the DA reading it aloud, starting within seconds.

## Ideal State

- The principal hears the DA's voice reading the content within a few seconds of asking, and the reply arrives while it is already playing.
- What is read is what was asked for: an explicit URL, file path, or pasted text when one is given; on bare "ri" / "read it" / "this", the most recent substantive thing in the conversation, and the DA's own piece when it just wrote one.
- A spoken script exists as a file in the scratch directory before `ReadIt.ts read --file` runs; for an external page it was authored from the fetched prose.
- What is spoken is a script a person would read aloud, not markup: no headers, table pipes, URLs, code, or emphasis markers; acronyms expanded on first use; figures said the way a reader says them ("about eighteen thousand posts", not "~18,000").
- The piece's own words and order survive. This is a read, not a summary; nothing is dropped except what cannot be spoken (tables become sentences carrying the same facts, link text stays, the URL goes).
- The reply names the title, the chunk count, and the estimated length, and says how to stop.
- "stop", "pause", "resume", and "where are you" work at any point.

## Anti-criteria

- Never invent a subject: when the last thing was an external source the DA summarized, ask one question ("The article itself, or my write-up of it?"); a fresh session with nothing in context and no argument asks what to read.
- Never paste the raw article into the tool and rely on the strip; the strip is a backstop for residue, not an author.
- No `--text` for more than a sentence or two.
- No `/notify` call anywhere in this intent.

## Output format

- The 🗣️ closer on a read turn stays to a few words ("Reading now."): it is spoken in the same voice and would talk over the opening line.

## Tool contract

```bash
bun ~/.claude/skills/ReadIt/Tools/ReadIt.ts read --file <script.txt> --title "<title>" [--voice <profile>]
```

The command returns after the first chunk starts. Its output carries title, chunk count, word count, an estimate in minutes, and the audio directory. Quote the estimate in the reply.

Reading an external page means fetching its full text first (the raw HTML with its body extracted in a `.ts` file, or the X reader tool for X URLs), then authoring the script from that prose. WebFetch returns a small model's summary, not the page, so it cannot carry a faithful read.

### Control

| Principal says | Run |
|---|---|
| "stop", "stop reading", "enough" | `ReadIt.ts stop` |
| "pause", "hold on" | `ReadIt.ts pause` |
| "resume", "keep going", "continue" | `ReadIt.ts resume` |
| "where are you", "how much is left" | `ReadIt.ts status` |

Each prints one line; relay it.
