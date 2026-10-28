# Alpha

The N highest-alpha ideas in one piece of content, as a ranked list of short, plain bullets: the net-new signal, with the background noise left out.

Alpha follows Shannon: the only real information is what differs from what the reader already expects. An idea counts as alpha when it is new, a new framing of a known idea, a new way to use or combine ideas, or a surprise that goes against consensus. It does not count when it is a fact everyone already holds, a summary of the topic, or generic advice.

## Ideal State

- The output has exactly N bullets. N is the leading number in the request (`ea 8` → 8) and defaults to 24 when no number is given. When the content holds fewer than N real alpha ideas, the output has fewer bullets and says so in one line, rather than padding.
- The bullets are ranked by alpha, so the first one is the idea a well-read reader in the field would find most surprising or most useful.
- Each bullet is about 8 words (6–10) and makes one claim in plain, approachable language, written the way Paul Graham would put it in an essay: concrete, unhyped, and clear on a first read.
- Each bullet carries the specific idea, number or framing from this content, so a reader who knows the topic learns something they did not know before. A bullet that could have been written without the content fails.
- Every idea comes from the full source text (Extract intent § Inputs) and is faithful to what the speaker or author actually claimed, with any hedge they gave kept.
- No two bullets make the same point.

## Anti-criteria

- No consensus restatement, topic summary or generic advice ("AI is changing everything", "work hard and stay curious") presented as alpha.
- No idea that is not in the source, and no claim made stronger than the source made it.
- No bullet over 10 words, and no sub-bullets, headers or commentary inside the list.
- No padding to reach N.

## Inputs

- The content, fetched exactly as `Intents/Extract.md` § Inputs says (YouTube transcript, raw article body, file, or pasted text).
- An optional leading count N. `ea <url>` means 24; `ea 8 <url>` means 8.

## Output format

```markdown
# EXTRACT ALPHA: {Content Title}
> {One line: what this is and who is talking}

- {highest-alpha idea, about 8 words}
- {next}
...
```

When the content has fewer than N alpha ideas, one line after the list says how many it had.

## References

- Ported from Fabric's `extract_alpha` pattern (Shannon novelty, 24 bullets of 8 words in Paul Graham's style), rewritten as an ideal state with a settable count.
- `Intents/Extract.md` § Inputs and § Gotchas cover fetching and long transcripts.
