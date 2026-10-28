# ShowIntroCheck

Checks a ShowIntro output (`Intents/ShowIntro.md`) against the parts of its contract that code can judge. Whether the topics are the show's most surprising parts, specific to it, spread across the whole of it and true to what was said, and whether the guest line holds only facts the show gives, stays a judged check in the `fabric-showintro` suite.

## Usage

```bash
bun skills/Fabric/Tools/ShowIntroCheck.ts <file|-> [--topics N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved intro, or `-` for stdin |
| `--topics N` | The exact topic count a hint asked for (1 to 10); without it any count from 3 to 10 passes |
| `--json` | Print `{ok, form, guests, topics, problems}` |
| `--help` | Print usage |

## Checks

- The output is exactly four blocks separated by blank lines: the opener, the lead line, the topic list and the closer. Anything before or after (a title, a note, alternatives) fails.
- The opener begins `In this conversation I speak with {guest}.` (guest form) or `In this episode I ` (solo form), is prose rather than a bullet, and holds at most 60 words.
- The lead line is exactly `We discuss:` in the guest form and `I cover:` in the solo form.
- The topic list holds only flat `- ` bullets: 3 to 10 of them, or exactly the `--topics` count. Each topic is 2 to 7 whitespace-separated words, does not end on a full stop or exclamation mark, and appears once (case and punctuation ignored).
- The closer is `And with that, here's my conversation with {guest}.` (or `the conversation with`), naming guests the opener named, in the guest form, and `And with that, here's the episode.` in the solo form. A straight or curly apostrophe passes.
- Nothing a host could not read aloud: no bold, italics or asterisks, no heading, no backticks, no link, no numbered list, no sub-bullet, and no template blank (`{...}` or `___`).
- A fact the input did not give appears as a `[TBD: ...]` marker. A marker passes every rule above and counts as one word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
