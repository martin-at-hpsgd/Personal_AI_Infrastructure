# Append

One row written to the record on a registered stream, with the right writer, class and pointer, and read back.

## Ideal State

- The row lands on a stream registered in `streams.ts`, under a `writer` that names who did the thing (`tool:<Name>`, `hook:<Name>`, `wf:<name>`, `app:<name>`), with `ref` pointing at the fuller detail (a commit, a URL, a transcript line) when one exists.
- The class is the stream's default unless the content needs a stricter one; anything carrying the principal's own words is `personal`.
- The row is read back with `tail --stream <stream>` and its `id` is reported.

## Anti-criteria

- Never appends to the `event` stream with `append`: notice-worthy rows go through `Statvs.ts event` or Vigil's Emit so validation and dedup run.
- Never puts restricted content in `title` (titles survive redaction) and never puts a secret, a credential or tenant content anywhere in the row.
- Never registers a new stream to make an append succeed; an unregistered stream is an Onboard decision.
- Never retries a refused row by loosening its class; a refusal is reported as the correct outcome.

## Safety gates

- **Refusal is the answer.** When the writer refuses a row (unregistered stream, secret-shaped value, personal data in a `public` or `system` row), report the refusal and its reason. Do not reshape the content to get it past the check.

## Tool contract

```bash
bun LIFEOS/STATVS/Statvs.ts append --writer <W> --stream <S> [--class C] [--app A] [--kind K] [--severity S] [--title T] [--session ID] [--ref R] --data '<JSON>'
bun LIFEOS/STATVS/Statvs.ts event --source <S> --kind <K> --severity <S> --title <T> --summary <S> [--ref R] [--url U] [--privacy public|personal] [--dedup KEY]
bun LIFEOS/STATVS/Statvs.ts tail --stream <S> --n 1
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "and let me know about it" / "flag it" | `event` with `--severity` | goes through Vigil's validation; Vigil decides whether to text |
| "for app X" | `--app <X>` with `--class customer` only for the principal's own business data | splits the row into that app's segment |
| "point at the commit" | `--ref <sha or URL>` | detail stays in git, the row points to it |

## Output format

The row's `id`, stream, writer and class in one line, or the refusal and its reason.
