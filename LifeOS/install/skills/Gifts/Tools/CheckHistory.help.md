# CheckHistory.ts - Help Documentation

Checks one saved Gifts run file for the parts of a FindGifts run that code can judge. Whether the ideas are any good stays a human call.

## Usage

```bash
bun skills/Gifts/Tools/CheckHistory.ts <History/<id>-<YYYY-MM-DD>[-N].md> [--json]
```

Run it from `~/.claude` on the History file the run just wrote.

## Checks

| Check | Fails when |
|---|---|
| `count` | the file holds fewer than 8 or more than 12 numbered ideas (`N. **Name**`, wildcard included) |
| `tag` | an idea has no URL, or its product URL (the first URL in the idea) has no `[verified…]` or `[unverified…]` tag on its line |
| `repeat` | an idea's name, lowercased with punctuation dropped, matches an idea in an earlier History file for the same id in the same directory: an earlier date, or an earlier run the same day (`-2`, `-3` suffixes) |

Unranked bullets (a "More options" list) and the source links in "What's moving" lines are not ideas and are not checked. The repeat check matches names exactly after normalizing, so a reworded repeat still needs a human eye.

## Flags

| Flag | Effect |
|---|---|
| `--json` | print `{file, ideas, failures[]}` instead of the PASS/FAIL text |

## Exit codes

`0` every check passed · `1` a check failed (each failure printed) · `2` no file given or a file could not be read.

## Tests

The synthetic-fixture tests in `CheckHistory.test.ts` live in the maintainer source tree and are not in the public release; there, `bun test ./skills/Gifts` runs them.
