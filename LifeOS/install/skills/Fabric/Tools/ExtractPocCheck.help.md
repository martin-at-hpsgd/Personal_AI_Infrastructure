# ExtractPocCheck

Checks an ExtractPoc output (`Intents/ExtractPoc.md`) against the parts of its contract that code can judge. Whether the commands are faithful to the source and invent no value stays a judged check in the `fabric-extractpoc` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractPocCheck.ts <file|-> [--json] [--no-parse]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, shape, commands, parse, problems}` |
| `--no-parse` | Structural checks only (no `bash -n` on the command block) |
| `--help` | Print usage |

## Checks

The output is one of two shapes, and the checker accepts exactly these:

- **Commands** — one fenced shell block (` ```bash `, ` ```sh `, ` ```shell `, ` ```zsh ` or an unlabelled fence) holding at least one command line, and nothing outside the fence. A second code block, a block labelled with a non-shell language, prose or commentary around the block, or an empty block fails. The block body is then syntax-checked with `bash -n`, which reads the commands but never runs them; a parse error fails.
- **None** — when the source has no runnable proof of concept, the whole output is the single line opening on `No runnable proof of concept` and nothing else. No fence, no extra lines.

An output that is neither (loose prose, a fence plus prose, several blocks) fails.

## Exit codes

- `0` the shape holds and the command block parses
- `1` a check failed; each failure prints as one `✗` line
- `2` bad usage, unreadable input, or `bash` missing (unless `--no-parse`)
