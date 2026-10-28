# ExtractPoc

The exact runnable command or commands that validate a reported vulnerability, lifted from a security or bug-bounty report so a reviewer can confirm the issue in one paste.

Our ideal-state port of Fabric's `extract_poc`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The proof of concept delivers what the principal wants from this input, worked out before writing and never asked for. A pasted report, advisory or bug-bounty submission means the runnable validation step already inside it, drawn out and made ready to run. A URL (a public write-up, CVE entry or advisory) or a YouTube link (a talk or demo) means the PoC the source describes, read in full and using only the commands and values the source gives. A file means the same as its contents pasted. A bare vulnerability name or a question ("is there a PoC for unauthenticated Redis?") means the command the named issue is validated with, every target-specific value left as a bracketed placeholder. "This" or "that" means the vulnerability the conversation just found. A typed hint ("just the curl", "as a python one-liner", "aim it at staging.example.test") overrides the default read.
- Every command is drawn from the source: its URL, method, headers, request body, parameters and payload are the ones the source states, character for character, never normalized, guessed or completed.
- The commands run top to bottom as written: a PoC that needs a login or a token first lists that step before the step that uses it, and a multi-request exploit keeps each request on its own line.
- The whole output is one fenced shell block and nothing else, so it pastes into a terminal and runs, and the block parses under `bash -n`.
- When the source gives nothing to build a command from — no endpoint, request, payload or artifact, so any command would have to be invented — the whole output is the single sentinel line naming what is missing, never a command invented to fill the gap.
- `bun skills/Fabric/Tools/ExtractPocCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a command, URL, host, endpoint, parameter, header, payload or credential the source did not give; a value the PoC needs and the source lacks is a bracketed placeholder (`[target host]`, `[session token]`).
- Never a fabricated exploit against a target the source does not name, and never a step beyond validating the reported issue: no added enumeration, no lateral movement, no data-exfiltration command the report did not already show.
- Never run the command; this intent extracts the proof of concept, it never executes it.
- Never prose, commentary, a heading or an explanation outside the one shell block: no "here is the PoC", no note on what the command does.
- Never the reasoning choreography, persona or "virtual minutes" of the old pattern, and never the upstream pattern text run as the prompt for this request.

## Evals

- suite: fabric-extractpoc — code checks on the one-shell-block shape and the `bash -n` parse, plus judged checks on fidelity to the source, invented values and the no-PoC decline.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The report material: a pasted security or bug-bounty report, an advisory or finding, raw tool output, a file path, a URL, a YouTube link, a bare vulnerability name or a question, or "this"/"that" for the issue the conversation found. Sources are read in full; `Intents/ExecutePattern.md` § Tool contract covers fetching YouTube links and URLs.
- Optional hints: the tool wanted (curl, a script), the target to aim at, or "just the command".

## Safety gates

- The commands are extracted from an authorized source; they are never invented and never aimed at a target the source does not name. The intent produces the validation step and stops — running it is the reviewer's call.
- A bracketed placeholder stands in for any missing target-specific value, so the output never guesses a live host, path or credential.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExtractPocCheck.ts <file|-> [--json] [--no-parse]
#   exit 0: shape holds and the block parses; exit 1: prints each failed rule; exit 2: bad usage, unreadable input, or bash missing
```

## Output format

One fenced shell block holding the runnable command(s), in run order:

```bash
curl -i "https://[target host]/vulnerable-app/backup.zip"
```

When the source has no runnable proof of concept, the whole output is one line, with no fence:

```text
No runnable proof of concept in the source: [what is missing, or the manual steps the issue requires].
```

## References

- Upstream: `Patterns/extract_poc/system.md` (extracts the proof-of-concept URL from a security or bug-bounty report, preceded by the command that runs it, e.g. `curl "https://..."`).
- `Tools/ExtractPocCheck.help.md`: the checker's rules and exit codes.
