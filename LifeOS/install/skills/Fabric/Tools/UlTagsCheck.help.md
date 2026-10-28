# UlTagsCheck

Checks a UlTags output (`Intents/UlTags.md`) against the parts of its contract that code can judge. Whether each tag is earned (central rather than tangential, in its stated scope) stays a judged check in the `fabric-ultags` suite.

## Usage

```bash
bun skills/Fabric/Tools/UlTagsCheck.ts <file|-> [--extra tag1,tag2] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--extra tag1,tag2` | Tags a hint allowed by name, accepted beside the twenty |
| `--json` | Print `{ok, tags, problems}` |
| `--help` | Print usage |

## Checks

- The whole output, trimmed, parses with `JSON.parse`. A code fence around it fails, because a pipeline reads the bytes as JSON.
- It is an object whose only key is `tags`, and `tags` is an array of strings.
- Every tag is one of the twenty in the intent's vocabulary (or an `--extra` tag), spelled exactly as listed. A near-spelling such as `AI` or `national-security` fails with the right spelling named.
- No tag appears twice.
- `ai` never appears without `technology`.
- An empty array passes: it is the right answer when nothing in the vocabulary fits.

## Exit codes

- `0` every rule holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
