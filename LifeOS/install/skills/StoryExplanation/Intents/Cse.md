# CSE - Create Story Explanation

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples

A numbered, N-line story explanation of a blog post, article, or any content, written with the embedded story-explanation prompt.

## Ideal State

- The output is exactly N numbered lines under the `📖 STORY EXPLANATION:` header, where N is the first number in the request (default 8, min 3, max 50; `/cse3` → 3, `/cse 24` → 24, `/cse` → 8), and a second number makes every line exactly that many words.
- Every line meets the embedded Story Explanation Prompt's Requirements and Formatting (Tool contract).
- Across its lines the explanation states every key concept of the source, the core story, context and background, the main arguments or themes, the author's intent and message, and the "so what" and implications, each traceable to the source, in readable, accessible language with no unexplained jargon.

## Anti-criteria

- Never an explanation that skips the embedded prompt's contract, comes from other summarization tools, or is bullet points or another format in place of the explanation.
- None of the cliche phrases the embedded prompt lists under "Avoid all cliche phrases".

## Inputs

**Format:** `/cse [LINES] [WORDS] [content]` (the argument form; an install may add line-count shortcut commands (3 lines, 8 lines) that invoke this skill with `CSE [N] — <args>`)

**Examples:**
- `/cse leaky abstraction` → 8 lines, 8-16 words each (defaults)
- `/cse 3 leaky abstraction` → 3 lines, 8-16 words each
- `/cse 8 8 leaky abstraction` → 8 lines, exactly 8 words each
- `/cse 24 10 https://example.com` → 24 lines, exactly 10 words each

**Argument Parsing:**
1. **First number** = line count (default: 8, min: 3, max: 50)
2. **Second number** = word count per line (default: flexible 8-16)
3. **Remaining** = content or URL

## Tool contract

The Story Explanation Prompt, embedded here, is applied to the fetched content at the requested line count. Cse always uses it and needs no external MCP tool:

````
# Background

You excel at understanding complex content and explaining it in a conversational, story-like format that helps readers grasp the impact and significance of ideas.

# Task

Transform the provided content into a clear, approachable summary that walks readers through the key concepts in a flowing narrative style.

# Instructions

## Analysis approach

- Take time to deeply examine the content from multiple perspectives
- Look at it from different angles until you truly understand what makes it significant
- Identify the core ideas and how they connect
- Find the most compelling way to explain this - the way you'd actually explain it if you spent hours understanding it and then shared it with a friend
- Ask yourself: "What would make someone think 'wow, I get it now!' and want to share this?"

## Output structure

Create a numbered narrative summary with N lines (specified by command, default 8):

**Format:**
```
📖 STORY EXPLANATION:
1. [First sentence - word count as specified]
2. [Second sentence - word count as specified]
3. [Third sentence - word count as specified]
... (continue for N lines)
N. [Final sentence - word count as specified]
```

**Requirements:**
- Exactly N numbered lines (where N is specified by user, default 8)
- If word count specified: EXACTLY that many words per line (strict)
- If no word count: 8-16 words per line (VARY naturally - some short, some longer)
- Numbered 1 through N for consistency
- Period at end of each sentence
- Varied sentence starters (Don't start every sentence with "I" or "The")
- Natural conversational flow (like explaining to a friend)
- Escalating story-based flow: background → main points → examples → implications → wow factor
- Written in 9th-grade English (conversational, not dumbed down)
- Adjust depth and coverage based on line count (3 lines = high-level, 24 lines = detailed)

**Example (8 lines - default):**
```
📖 STORY EXPLANATION:
1. The speaker has spent ten years redesigning bus networks for mid-sized cities.
2. She says riders forgive a slow bus far more easily than a long wait.
3. Most networks lose people at transfers, where two routes almost meet but never line up.
4. Her team shifted departure times by a few minutes so the main transfers matched.
5. The buses and the routes stayed exactly the same as before.
6. Ridership on the connected routes went up within a single season.
7. The city spent almost nothing, because a timetable costs less than a new bus.
8. If she's right, plenty of cities could fix transit with a schedule instead of a budget.
```

**Example (3 lines - concise):**
```
📖 STORY EXPLANATION:
1. Joel Spolsky's Law of Leaky Abstractions states all non-trivial abstractions leak implementation details.
2. SQL databases and TCP networking both abstract complexity but expose internals when stressed.
3. Experienced developers must understand lower layers because complexity relocates rather than disappears.
```

**Example (12 lines - detailed):**
```
📖 STORY EXPLANATION:
1. A leaky abstraction is when simplified interfaces fail to hide underlying complexity.
2. Joel Spolsky coined the Law of Leaky Abstractions in software engineering.
3. The law states all non-trivial abstractions eventually leak their implementation details.
4. Abstractions are created to hide complexity and make things easier to use.
5. But these abstractions inevitably expose details when things go wrong or get stressed.
6. SQL databases abstract file systems but expose indexes when queries slow down.
7. TCP/IP promises reliable transfer but you face timeouts when connections fail.
8. Each abstraction layer leaks, creating stacks of partially-hidden complexity that compound.
9. This means developers can't just learn the high-level interface they work with.
10. They must understand six layers beneath because leaks expose lower implementation details.
11. Experienced developers need deep knowledge of supposedly irrelevant lower-level systems.
12. The core insight: complexity can't be eliminated, only relocated until it surfaces.
```

## Voice and style

Write as the author sharing something interesting with their audience, following any voice notes supplied with the input:
- First person perspective
- Casual and direct
- Natural conversational tone (like telling a friend after you really got it)
- Never flowery, emotional, or journalistic
- Let the content speak for itself

**Avoid all cliche phrases (a default list; voice notes supplied with the input can add to it or replace it):**
- "at a crossroads"
- "game-changer" / "game changing"
- "double-edged sword"
- "paradigm shift"
- "revolutionary"
- "groundbreaking"
- "alarming"
- "shocking"
- "incredible"
- "mind-blowing"

## Formatting

- Output Markdown only
- No bullet markers - separate sentences with line breaks
- Period at end of each sentence
- Stick to the facts - don't extrapolate beyond the input
````

## Output format

The prompt's format exactly: the `📖 STORY EXPLANATION:` header, then N numbered lines, no bullets.

## Examples

**Command forms** (the `/cse NUMBER` forms are also written without the space):
```
/cse3 leaky abstraction
/cse 24 https://example.com/article
/cse24 https://example.com/article
```

Or provide content and say:
- "run CSE on this" (8 lines)
- "run CSE3 on this" (3 lines)
- "explain this story with 24 lines" (24 lines)
