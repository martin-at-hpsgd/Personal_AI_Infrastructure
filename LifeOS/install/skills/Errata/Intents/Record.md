# Record

One erratum filed from the principal's words as one new ledger line.

## Ideal State

- One new ledger line exists whose `complaint` is the principal's words verbatim. The only changes are the leading kind tag (`bug:` and the rest of the table below), which sets `kind`, and whitespace trimmed from both ends.
- Its `kind` matches the leading tag, and its `target` is `lifeos-product` only when `--product` was given.
- Its context carries the current session id and, when the terminal transcript is reachable, the ask before it and the last response.
- A stranger could investigate the line a month later without the transcript: it holds the verbatim words, the kind, which system, what was being asked when it was said, and what the system had just answered.
- `errata show <id>` renders it back and nothing in it is a secret.
- The reply shows the id and the kind on one line.

## Anti-criteria

- Never restates the complaint in its own words: `Er.ts` writes the principal's text verbatim, and a paraphrase at capture destroys the one field that cannot be regenerated.
- Never adds tags, a summary, or a `rating` the principal did not give: a rating is only ever a number the human typed, never an estimate.
- Never files a standing rule ("From now on X") here too: it belongs to the Upgrades store via the SatisfactionCapture directive leg, and a second copy creates a duplicate the triage job will chase.

## Inputs

Everything after `/er` is the payload.

## Tool contract

```bash
bun ~/.claude/skills/Errata/Tools/Er.ts [--product] [--system <lifeos|other|a name from errata-systems.json>] [--session <id>] [--transcript <path>] "<text>"
```

| Leading tag in the text | kind |
|---|---|
| `bug:` | bug |
| `feature:` / `feat:` | feature-request |
| `praise:` | praise |
| `question:` / `q:` | question |
| `incident:` | incident |
| (none) | complaint |

Pass the session id from the hook input when you have it; the tool falls back to `CLAUDE_SESSION_ID` and then to `none`.
