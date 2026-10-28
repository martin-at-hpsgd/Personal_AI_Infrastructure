# Coverage.ts - Help Documentation

The Trim intent's mechanical coverage check. It confirms a merge or tighten kept every load-bearing token of the original text, and that a relocated excerpt landed in its reference unchanged.

## Usage

```bash
# Merge or tighten: original text vs replacement text
bun ~/.claude/skills/Trim/Tools/Coverage.ts <original-file> <replacement-file>

# Relocate: the moved excerpt vs the reference file it moved to
bun ~/.claude/skills/Trim/Tools/Coverage.ts --verbatim <excerpt-file> <reference-file>
```

Write the original and replacement text to scratch files first; the tool reads files, never the live doctrine file in place.

## What it checks

Default mode extracts these tokens from the original and reports each one the replacement no longer contains:

- backtick spans
- file paths (anything with a slash) and bare filenames with a known extension
- env-var and ALL_CAPS names
- `--flags`
- CamelCase names and capitalized words in mid-sentence (proper nouns, tool names)
- the directive words never, always, must, only (case-insensitive)

`--verbatim` passes when the excerpt appears in the reference exactly, ignoring trailing whitespace on each line.

It does not judge whether the replacement compels the same behavior or whether every imperative verb survived. That stays the human read-back in the Trim intent's Safety gates.

## Output

One JSON line on stdout:

```json
{"mode":"coverage","ok":false,"checked":14,"missing":["tools/Gate.ts","never"]}
{"mode":"verbatim","ok":true}
```

Exit codes: 0 every token survives (or the excerpt is verbatim), 1 something is missing, 2 usage error or unreadable file.

## Tests

```bash
# Fixture tests live in the maintainer source tree and are not in the public release.
bun test ./skills/Trim
```
