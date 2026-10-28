# Create Story Explanation With Links

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format · References

A narrative story explanation of n sentences with inline source links after each sentence, in the user's voice.

## Ideal State

- A source map of topic to URLs (shape in Tool contract) existed before the narrative was written, built from every source URL in every provided source: direct links in text, markdown link references, footnote URLs, and source lists at the end of documents.
- The narrative is exactly n sentences (user-specified or default 25), one sentence per line with a period at the end of each: an opening sentence of 15-25 words that hooks with plain descriptors in first person, a body of n-2 sentences with escalating story flow and varied sentence length (8-20 words), and a closing sentence of 15-25 words with a "wow" factor without hyperbole. The arc is the one the chosen framing (per `NarrativeFraming.md`, or the user-specified angle) leads to.
- Each sentence draws its content from the source material and pairs concrete facts with interpretive framing, sentences across the narrative connect facts from different sources, and the closing sentence states the insight or conclusion the body builds toward.
- Every sentence that mentions a specific verifiable claim is followed by all the links relevant to it, in the link form Output format gives; a narrative transition with no such claim carries none.
- The output opens with the `## 📖 STORY EXPLANATION (N ITEMS)` header, carries all sentences with inline links, and ends with a **Primary Sources** list.

## Anti-criteria

- Never puts a maximum on links per sentence: if a sentence mentions 10 things, it links all 10.
- No numbered lists or bullet points in the narrative.

## Inputs

| Input | Values |
|---|---|
| Content source | file path(s), pasted text, previous conversation output, or multiple sources combined |
| Story length | user-specified (e.g., "15 sentences", "30-item story"); default 25 sentences |
| Narrative framing | user-specified angle (e.g., "enterprise focus", "platform shift", "agent autonomy"); default per `NarrativeFraming.md` |

## Safety gates

**If content has no URLs:**
- Notify user: "The content doesn't contain source URLs for attribution. Would you like me to generate the story explanation without inline links?"
- Offer to proceed without links if user confirms

**If content is too short:**
- Under 300 words of content: refuse a 25-sentence request.
- Otherwise, when the requested length exceeds the viable length (1 sentence per ~100 words of content), offer that length instead: "The content is only sufficient for approximately X sentences. Would you like me to generate that length instead?"

## Tool contract

The source map (Ideal State) has this shape:
```typescript
{
  "topic1": ["url1", "url2"],
  "topic2": ["url3", "url4", "url5"],
  // ...
}
```

If the story explanation is valuable for future reference and Config.md names a save directory:
- Save to: `<save directory>/YYYY-MM/YYYY-MM-DD_story-explanation-[topic].md` (with no save directory configured, do not save)
- Include both the narrative and the source content
- Add metadata: date generated, source files, length

## Output format

The links after each sentence:
- Sentence text. [LINK 1](URL) | [LINK 2](URL) | [LINK 3](URL) | [etc.]
- Keep link titles short (2-6 words): "ANTHROPIC BLOG", "GITHUB DOCS", "ARXIV PAPER"
- Use pipe `|` to separate multiple links
- Include every link relevant to that sentence's claims
- Links come after the period, before the line break
- If a sentence doesn't mention specific verifiable claims, no links needed (narrative transitions)
- A malformed source URL is cleaned up (remove extra characters, validate format); if unable to fix, include a placeholder and note it in the output

**Example patterns:**

Single development:
```
A regional library system put its whole catalog behind a single search box last spring. [LIBRARY ANNOUNCEMENT](https://example.com/library/one-search-box)
```

Multiple developments in one sentence:
```
Three neighboring towns opened shared tool libraries, a seed exchange, and a repair café in the same month. [TOOL LIBRARY](https://example.com/towns/tool-library) | [SEED EXCHANGE](https://example.com/towns/seed-exchange) | [REPAIR CAFE](https://example.com/towns/repair-cafe)
```

Narrative sentence (no specific claims):
```
That combination changed how people in those towns borrow and fix things.
```

Present the final story explanation in this format:

```
## 📖 STORY EXPLANATION (N ITEMS)

[Sentence 1]. [LINK](URL) | [LINK](URL)

[Sentence 2].

[Sentence 3]. [LINK](URL) | [LINK](URL) | [LINK](URL)

[Continue for all n sentences...]

[Final sentence]. [LINK](URL)

---

**Primary Sources:**
- [Source 1 name/description]: [URL]
- [Source 2 name/description]: [URL]
- [etc.]
```

Optional: metadata about generation (length, framing used, sources count) after the Primary Sources list.

## References

- `NarrativeFraming.md` — the framing rule and angle palette (offer 2-3 angles and ask only if genuinely ambiguous).
