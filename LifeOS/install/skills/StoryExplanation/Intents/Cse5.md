---
title: CSE5 - Create Story Explanation (5-Line)
description: Generate clean 5-line story explanations from content
type: prompt
---

# CSE5 - Create Story Explanation (5-Line)

A clean, scannable 5-line numbered story explanation of a blog post, article, or any content.

## Ideal State

- The five lines condense the whole of the source, not just its opening, and say nothing it does not.
- The output is exactly 5 numbered lines, no more, no less, in the order setup/context, problem/challenge, solution/approach, implementation/action, outcome/impact, each one complete, clear sentence covering one distinct concept.
- Lines flow logically from 1 to 5, each self-contained but flowing with the others, in simple, readable, scannable language with no complex nested clauses or run-on sentences, no fluff or filler words, and no jargon unless necessary.

## Anti-criteria

- Never a summary written without the explainer tool or the embedded prompt, taken from other summarization tools, in bullet points or another format, or skipping the 5-line formatting.

## Tool contract

- With an explainer MCP tool named in Config.md: call it with the input content (direct content or content fetched from URL).
- With none configured: apply the embedded Story Explanation Prompt in `Intents/Cse.md` to the content at 5 lines.

## Output format

The output must be exactly 5 lines, numbered, with one clear concept per line:

```
1. [First key point - setup/context]
2. [Second key point - problem/challenge]
3. [Third key point - solution/approach]
4. [Fourth key point - implementation/action]
5. [Fifth key point - outcome/impact]
```

## Examples

**Input**: Blog post about a town that moved its bus fleet to electric

**Output**:
```
1. A small town wanted cheaper, quieter public transit.
2. Diesel buses cost too much to fuel and repair.
3. The town replaced half its fleet with electric buses over two years.
4. Drivers and mechanics were retrained before the first route launched.
5. Maintenance costs fell and ridership rose on the converted routes.
```

```
/cse5 [content to explain]
```

Or provide content and say "run CSE5 on this" or "explain this in 5 lines"
