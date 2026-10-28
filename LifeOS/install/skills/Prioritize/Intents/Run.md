# Run

Produce a fresh set of recommendations and report what changed.

## Ideal State

- `latest.json` reflects the current inputs, or the run reports honestly why it skipped or failed.
- The answer to the principal leads with the focus summary and the top three, then names any source errors.
- Every recommendation names the next action and links real inputs; nothing is invented.
- The top three reflect consequence and goal leverage first, novelty last.
- A run with unchanged inputs costs zero tokens; a changed run is one lightweight-lane OpenAI call.
- Stale mirrors and failed runs are visible on the page, never hidden behind old output.

## Anti-criteria

- Running this never creates issues, edits TELOS, or sends messages; it is display-only.
- Never uses `--force` other than when asked or when the principal wants a re-rank; a skip ("no new inputs") is a correct result.

## Tool contract

| Principal says | Command |
|---|---|
| "run prioritize", "what should I work on" | `bun ~/.claude/skills/Prioritize/Tools/Prioritize.ts run` |
| "refresh anyway", "force it" | `... run --force` |
| "what does it see", "show the inputs" | `... digest` |
| "show me the list" | `... show` |
