# ExtractInstructionsCheck

Checks an ExtractInstructions output (`Intents/ExtractInstructions.md`) against the parts of its contract that code can judge. Whether the steps are faithful to the source, complete, in the order the reader must do them, grouped as the source groups them, and carry their warnings and checks stays a judged check in the `fabric-extractinstructions` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractInstructionsCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, objectives, needs, steps, none, problems}` |
| `--help` | Print usage |

## Checks

- The output opens on a `# Instructions: ` title.
- Either the title and the single line `No instructions found in {the source}.`, and nothing else, or the sections below.
- Sections are `## Objectives`, an optional `## You need`, and `## Instructions`, in that order, each once. Any other heading fails, and so does text outside a section.
- Objectives: 1 to 10 top-level `- ` bullets of 3 to 15 words, no two the same.
- You need: when present, at least one top-level `- ` bullet.
- Instructions: a numbered list (`1. `) at column 0 counting 1, 2, 3 with no gap, at least one step, each at most 40 words, no two the same. Sub-steps are bullets or numbers indented two or more spaces under a step, at most 25 words each. A fenced code block indented under a step is allowed and not counted; one at column 0 fails.
- One action per step: a step or sub-step that joins two actions with "then" (`, then`, `; then`, `and then`) fails, unless the "then" closes a condition that opens with if, when, once, unless, until, after or before.
- No bold or italics anywhere outside inline code.

Words split on whitespace; punctuation at a word's edges is ignored, and a token of pure punctuation (an em-dash) is not a word.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
