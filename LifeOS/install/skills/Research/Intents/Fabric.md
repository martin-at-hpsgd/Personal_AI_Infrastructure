# Fabric

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Examples · References

Content processed through the right Fabric pattern, chosen from 242+ for what the user is trying to accomplish.

## Ideal State

- The pattern fits what the user is trying to accomplish: the request's intent category matches the decision matrix under References and the full selection table in `skills/Fabric/Intents/ExecutePattern.md` (for example `create_threat_model` for a threat model, unless STRIDE is specified).
- The selected pattern was executed immediately on the user's content and its output returned: natively, by applying `skills/Fabric/Patterns/<name>/system.md`, with the fabric CLI only for a YouTube URL (`-y`) or a URL whose native fetch failed (`-u`).
- A request to update patterns routes to the Fabric skill's UpdatePatterns intent ("update fabric patterns").

## Anti-criteria

- Never hands the user the pattern list to choose from ("Here are the patterns, pick one"); the pattern is named and executed ("I'll use `create_threat_model` for this").

## Inputs

Requests such as "Create a threat model for...", "Summarize this article/video/paper...", "Extract wisdom/insights from...", "Analyze this [code/malware/claims/debate]...", "Improve my writing/code/prompt...", "Create a [visualization/summary/report]..." or "Rate/review/judge this content...".

## Tool contract

### CLI forms (YouTube, blocked URLs, pipes)

The run uses the CLI only for the two cases in the Ideal State; content already in hand (a file, a paste, fetched text) is processed natively.

```bash
# Basic format
fabric [input] -p [selected_pattern]

# From URL
fabric -u "URL" -p [pattern]

# From YouTube
fabric -y "YOUTUBE_URL" -p [pattern]

# From file
cat file.txt | fabric -p [pattern]

# Direct text
fabric "your text here" -p [pattern]
```

**Process YouTube videos:**
```bash
# Fabric handles download + transcription + processing
fabric -y "https://youtube.com/watch?v=..." -p youtube_summary
```

**Chain patterns:** run the first pattern, then apply the second to its output (for example `extract_wisdom`, then `create_5_sentence_summary`).

## Examples

| User says | Pattern | How it runs |
|---|---|---|
| "Create a threat model for our new API" | `create_threat_model` | native, on the API description |
| "Summarize this blog post" | `summarize` | native, on the fetched post; `fabric -u "https://example.com/blog-post" -p summarize` only if the fetch is blocked |
| "Give me a 5-sentence summary" | `create_5_sentence_summary` | native |
| "Extract wisdom from this video" | `extract_wisdom` | `fabric -y "https://youtube.com/watch?v=..." -p extract_wisdom` |
| "What are the main ideas?" | `extract_main_idea` | native |
| "Analyze this code for issues" | `review_code` | native, on the code |
| "Analyze these security claims" | `analyze_claims` | native, on the claims |

## References

### Primary Skill Reference

**Primary Skill:** `~/.claude/skills/Fabric/SKILL.md` (pattern catalog by category; `skills/Fabric/Intents/ExecutePattern.md` holds the selection table, decision tree and native execution)
**Patterns Location:** `~/.claude/skills/Fabric/Patterns/`

### Pattern Selection Decision Matrix

| User Request Contains | Likely Intent | Recommended Patterns |
|----------------------|---------------|----------------------|
| "threat model" | Security modeling | `create_threat_model`, `create_stride_threat_model` |
| "summarize", "summary" | Summarization | `summarize`, `create_5_sentence_summary` |
| "extract wisdom", "insights" | Wisdom extraction | `extract_wisdom`, `extract_insights` |
| "analyze [X]" | Analysis | `analyze_[X]` (match X to pattern) |
| "improve", "enhance" | Improvement | `improve_writing`, `improve_prompt` |
| "create [visualization]" | Visualization | `create_mermaid_visualization`, `create_markmap_visualization` |
| "rate", "judge", "evaluate" | Rating | `rate_content`, `judge_output` |
| "main idea", "core message" | Core extraction | `extract_main_idea`, `extract_core_message` |

### Supplementary Resources
**Fabric Documentation:** https://github.com/danielmiessler/fabric
**Pattern Templates:** See `~/.claude/skills/Fabric/Patterns/official_pattern_template/`
