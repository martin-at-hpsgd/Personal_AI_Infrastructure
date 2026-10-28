# CreateCommandCheck

Checks a CreateCommand output (`Intents/CreateCommand.md`) against the parts of its contract that code can judge. Whether the command uses only flags the supplied documentation lists, and whether it meets the objective, stays a judged check in the `fabric-createcommand` suite.

## Usage

```bash
bun skills/Fabric/Tools/CreateCommandCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, command, problems}` |
| `--help` | Print usage |

## Checks

- The output is one command and nothing else: no markdown code fence (```` ``` ```` or `~~~`), heading, bullet, blockquote, or bold.
- No note or prose: a line opening on a note lead-in (`Note`, `Warning`, `Here is`, `This command`, and the like) fails, and so does a plain English sentence (ends in `.`/`!`/`?`, six or more words, and no shell characters).
- No unfilled placeholder: a `<word>` token (for example `<target>`) fails, because the objective's concrete value belongs there.
- Exactly one command block; two groups separated by a blank line fail.
- The command parses as valid shell. The checker runs `bash -n`, which parses the command without executing it; when no shell is available this check is skipped rather than failed.

## Exit codes

- `0` the shape holds and the command parses
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
