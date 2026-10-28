# ExtractReferencesCheck

Checks an ExtractReferences output (`Intents/ExtractReferences.md`) against the parts of its contract that code can judge. Whether each work is real, rightly credited, actually referred to, used as its note says, and whether the list misses any work the content points to stays a judged check in the `fabric-extractreferences` suite.

## Usage

```bash
bun skills/Fabric/Tools/ExtractReferencesCheck.ts <file|-> [--source <input-file>] [--max N] [--words N] [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--source <input-file>` | The input the references came from; every bullet not marked `alluded` or `unidentified` must have its title appear in it, and every URL must appear in it whole and exactly |
| `--max N` | The most bullets allowed (default 20, the hinted count when a hint set one, `0` for no cap) |
| `--words N` | The most words in a whole bullet (default 16, the hinted length when a hint set one) |
| `--json` | Print `{ok, noReferences, heading, references, leftOut, problems}` |
| `--help` | Print usage |

## Checks

- The first line is one bold heading (`**References in the offsite notes**`).
- Every reference is a bullet shaped `- *Title*, Creator (kind): note`, optionally closed by ` <URL>`. The creator and its comma may be left off; the kind is one to three words, optionally followed by `, alluded` or `, unidentified`. An `unidentified` bullet names no creator. A URL anywhere but the end of the bullet, a numbered list, or a bullet in any other shape fails.
- Each note holds at most 12 words (the closing URL is not part of the note), and each whole bullet, title and URL included, holds at most 16 words, or `--words N`. Words split on whitespace; punctuation at a word's edges is ignored, and a hyphenated compound or a number is one word.
- No title appears twice (compared case-, punctuation- and hyphen-insensitively).
- At most 20 bullets, or `--max N`.
- An optional `**Left out:** N …` line comes last, counts at least one, and appears only when the list is exactly at the cap.
- No template placeholder (`{…}`) is left in, and no other line appears.
- Input with no works is the single line `**No references:** …`, and nothing else.
- With `--source`, every URL in a bullet, as its title or at its end, appears in the input as a whole URL, character for character, so a URL is never invented or altered.
- With `--source`, each bullet not marked `alluded` or `unidentified` has its main title (before any `: subtitle`, without a leading "The", "A" or "An") appear in the input, compared case-, punctuation- and hyphen-insensitively, so `*Moby-Dick*` matches "moby dick".

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
