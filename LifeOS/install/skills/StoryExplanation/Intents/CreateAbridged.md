---
title: Create Abridged Story Explanation
description: Generate 5-line story explanations from URLs, YouTube videos, or raw text
type: prompt
---

# Create Abridged Story Explanation

An ultra-concise 5-line story explanation (5-12 words per line) of any source: an article, a YouTube video, or raw text.

## Ideal State

- The five lines retell the whole source in order, from what it is about to why it matters, and say nothing it does not.
- Exactly 5 lines in the order Setup, Background, Main Point, Implication, Impact, each 5-12 words.
- Each line ends with a period, lines are separated by a single line break, and there are no bullet points or numbers and no additional commentary.

## Anti-criteria

- Never a summary written without the explainer, taken from other summarization tools, or in a longer format.
- Never outputs more or fewer than 5 lines, or a line outside 5-12 words.

## Tool contract

With an explainer MCP tool named in Config.md, call it with the fetched content or raw text. With none configured, apply the embedded Story Explanation Prompt in `Intents/Cse.md` to it at 5 lines.

## Output format

Exactly 5 lines with 5-12 words per line:

```
[Line 1: Setup - 5-12 words]
[Line 2: Background - 5-12 words]
[Line 3: Main Point - 5-12 words]
[Line 4: Implication - 5-12 words]
[Line 5: Impact - 5-12 words]
```

## Examples

Requests such as "abridged story explanation of https://youtube.com/watch?v=abc123" (fetched with `fabric -y https://youtube.com/watch?v=abc123`), "... of https://example.com/article" (fetched with `fabric -u https://example.com/article`), or pasted text (used directly, no fetch). Output for a pasted note on a study of AI models:

```
This researcher studied how AI language models learn and evolve.
They discovered these models develop abilities nobody explicitly programmed in.
The surprising finding suggests consciousness-like properties emerge from sheer complexity.
This challenges our assumptions about what creates genuine awareness.
It means consciousness might not require biological brains after all.
```
