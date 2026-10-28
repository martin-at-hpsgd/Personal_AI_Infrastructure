# HarvestText

A raw text paste (quoted block, voice-note transcript, anything without a URL) harvested into Cortex as a note.

## Ideal State

- The note comes from `harvest.ts --type text` through the same Workflows POST and HarvestExecutor pipeline as the URL intents, and the reply reports the printed summary, its source `manual:text-<hash>`.
- Re-pasting the same text is detected as a duplicate by Workflows' `UNIQUE(source, external_id)`, through the content-hash external_id the tool generates.
- The harvested item carries a human-readable title from the tool (the text itself when short, otherwise its first sentence), with no LLM call at that stage.

## Anti-criteria

- Never skips `--type text` and lets the tool guess: if the text starts with "http://" or "https://" anywhere, the auto-detect may try to extract it as a URL.
- Never pastes more than ~50KB of text: Workflows' classifier has a context budget; over that, truncate or summarize first.
- Never treats this as a freeform note dump: this intent harvests external signal. A personal note goes through the Cortex skill's note intents, and nothing is ever written to `MEMORY/KNOWLEDGE/` by hand.

## Inputs

Input has no `http(s)://` scheme — it's just text. Examples: `harvest "<quoted block>"`, `harvest the following:` followed by pasted content, or piped stdin.

## Tool contract

Pass `--type text` so source detection doesn't try to fetch a URL:

```bash
bun ~/.claude/skills/Harvest/Tools/harvest.ts --type text "<text block>"
# or via stdin
echo "<text>" | bun ~/.claude/skills/Harvest/Tools/harvest.ts --type text -
```

The external_id is the first 16 hex chars of the text's sha256. The title is the text itself when the input is short (<200 chars, truncated to 120 chars), otherwise its first sentence.

## Output format

The printed summary (fields in SKILL.md § Tool contract), its source `manual:text-<hash>`.
