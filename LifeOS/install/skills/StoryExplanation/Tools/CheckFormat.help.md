# CheckFormat.ts - Help Documentation

Checks one StoryExplanation output against the format contract of the intent that produced it. It is deterministic: line and word counts, numbering, the header, bullets and labels, periods, link placement and the cliche list. It does not judge voice, framing or fidelity to the source.

## Usage

```bash
bun skills/StoryExplanation/Tools/CheckFormat.ts --format <create|links|abridged|cse|cse5> [--lines N] [--words N] [--file <path>] [--json]
```

The output is read from `--file`, or from stdin when no file is given.

| Flag | Meaning |
|---|---|
| `--format` | the intent's format: `create` (Create), `links` (CreateWithLinks), `abridged` (CreateAbridged), `cse` (Cse), `cse5` (Cse5) |
| `--lines N` | `cse`: the requested line count (default 8, 3-50). `links`: the requested sentence count (default: the header's N) |
| `--words N` | `cse`: the exact words per line the request named (default: 8-16 per line) |
| `--json` | print `{format, ok, violations}` instead of one violation per line |

## Exit codes

- `0` the output conforms
- `1` violations, one per line on stdout
- `2` usage error (unknown format, bad number)

## What each format checks

| Format | Checks |
|---|---|
| `create` | 7-17 sentence lines, opening and closing 15-25 words, every line ends with a period, no headers, no Opening/Body/Closing labels, no bullets or numbers |
| `links` | `## 📖 STORY EXPLANATION (N ITEMS)` header matching the sentence count, opening and closing 15-25 words, period before any links, no numbered lines, a `**Primary Sources:**` list |
| `abridged` | exactly 5 lines of 5-12 words, period-ended, no bullets or numbers |
| `cse` | `📖 STORY EXPLANATION:` header, exactly N lines numbered 1..N, 8-16 words each or exactly `--words`, period-ended |
| `cse5` | exactly 5 lines numbered 1..5, period-ended (a CSE header is tolerated) |

Every format also fails on any phrase in the default cliche list, which the tool reads from the embedded prompt in `Intents/Cse.md`. Voice notes that extend that list are not read; check those by eye.

## Tests

```bash
# Fixture tests live in the maintainer source tree and are not in the public release.
bun test ./skills/StoryExplanation
```

The tests also run the checker over the worked examples in `Intents/Cse.md`, `Intents/CreateAbridged.md` and `Intents/Cse5.md`, so an example that drifts from its own contract fails.
