# HarvestUrl

An article, blog post, newsletter, or general web page harvested into Cortex via Workflows + HarvestExecutor.

## Ideal State

- The note comes from the single `harvest.ts` command, which handles source detection, body fetch, Workflows POST, and HarvestExecutor invocation, with no manual step.
- The result is surfaced to the principal as a single readable block drawn from the printed summary, including the file path so the note can be opened.
- A `duplicate` from Workflows is reported with the existing entry's path, looked up through `/items`, and nothing is re-written.
- A Workflows 5xx or a non-zero tool exit is surfaced as the actual error.

## Anti-criteria

- Never falls back to handcrafting a Knowledge note when Workflows returns 5xx or the tool exits non-zero; that is the failure mode this skill exists to prevent.
- Never calls `WebFetch` and writes to `MEMORY/KNOWLEDGE/` directly; avoiding that is the reason this skill exists.
- Never forges an `id` to skip Workflows when the worker is unreachable. Surface the failure; don't paper over it.

## Inputs

Input is an `http(s)://` URL whose host is not `youtu.be` / `youtube.com`. Articles, blog posts, LessWrong / Substack / Medium / Reddit / news sites, etc.

## Tool contract

```bash
bun ~/.claude/skills/Harvest/Tools/harvest.ts "<URL>"
```

The duplicate lookup command is in SKILL.md § Tool contract.

## Output format

One readable block drawn from the summary `harvest.ts` prints (fields listed in SKILL.md § Tool contract), with `source` (for example `manual:lesswrong-<id>`) and every path in `executor.paths_written`.
