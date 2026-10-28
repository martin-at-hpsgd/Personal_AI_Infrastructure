# ClaudeResearch

Web research on one question through Claude's built-in WebSearch, decomposed into parallel targeted sub-queries.

## Ideal State

- The answer rests on 4-8 targeted sub-queries, the original question among them, that together cover the angles this question needs (often background, current-year developments, technical detail, alternatives, expert analysis and implications).
- The answer includes findings from the sub-queries run through Claude's WebSearch and from follow-up searches on what those initial findings turned up.
- The answer is one comprehensive synthesis of all findings, from the first round and the follow-ups alike.

## Anti-criteria

- No more than 8 sub-queries are run from one decomposition.
- No API keys or paid research vendors are used: this intent is Claude WebSearch only.
- No research runs without a research question; a missing question gets the usage line instead.

## Tool contract

Invoked through the Research skill, `Skill("Research", "claude research <your question>")`, which hands the decomposed queries to the ClaudeResearcher agent. It uses Claude's built-in WebSearch, so no API keys are needed and usage is free and unlimited. The sub-queries run in parallel, and the follow-up searches run before the answer is written.

## Gotchas

- There is no standalone command file for this intent (reported upstream, 2026): the command path an older header named never existed in the payload. The only way in is the `Skill("Research", ...)` call above.
