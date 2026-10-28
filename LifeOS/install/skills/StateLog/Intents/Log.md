# Log

Capture one state entry.

## Ideal State

- The entry is in `LIFEOS/USER/STATE/log.jsonl` with the right dimension, value, source, and any note, written by a single tool call.
- The reply is exactly one short acknowledgment line (the tool's own output is fine). Silent ack is the contract.
- Every rating dimension (H, M, E, S, R, F, C, CF) comes only from the user's own words. Signals and inference may reset W/K freshness, never write a rating.
- A natural-language rating is translated to its letter and 1-5 value (3 = average), with the user's phrasing kept as the note.

## Anti-criteria

- Never invent a rating the user didn't state: all eight rating dims are user-only, and signals touch W/K only.
- Never editorialize the note: it holds verbatim user words or nothing.
- No follow-up questions, no analysis, no charts, no ceremony after the acknowledgment.

## Tool contract

Each kind of input maps to one tool call:

- Shorthand (`M2`, `h1 rough morning`) → `bun ~/.claude/LIFEOS/TOOLS/State.ts log "<verbatim entry>"`
- Natural language rating ("my mood is pretty good today") → `log "M4 pretty good today"`
- Workout/walk happened ("just worked out", "went for a walk", the signal source named in Config.md reports a session) → `bun ~/.claude/LIFEOS/TOOLS/State.ts reset W` (or `K`) — source `signal` is applied by the reset command automatically.
- During an interview leg → add `--source interview`.

## Output format

- A tool error (unknown letter, missing value) surfaces as the tool's one-line error; suggest the roster only when the letter was unknown.
