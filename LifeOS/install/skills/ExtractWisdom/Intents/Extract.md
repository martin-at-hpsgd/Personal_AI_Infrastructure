# Extract Intent

**Contents:** Ideal State · Anti-criteria · Inputs · Output format · Gotchas · References

Dynamic, content-adaptive wisdom extracted from one content source: sections named for this content, spoken-voice bullets, and the closing sections its depth level calls for.

## Ideal State

- Every quote, number and detail comes from the full source text (the whole transcript, article body, file or pasted text), never from a summary or a partial fetch.
- The extraction is at the requested depth level, Full when no level is specified, with the section count, bullets per section and closing sections that level's row in § Output format gives.
- Sections are named for THIS content the way a magazine editor would name them, so the name makes the reader curious: "The Death of 80% of Apps," not "Technology Predictions." The test is whether a reader would open the section on its name alone; a topic label like "Programming Philosophy" or "Money Philosophy" fails it.
- Every section has at least 3 strong Level-3 bullets, except Fast, where 3 tight bullets IS the section; a domain that cannot reach 3 is merged into a related section.
- Each bullet is spoken, not summarized: it reads like telling a friend over coffee what you just watched, never a press release, a compressed info nugget or a clever one-liner.
- Each bullet carries the actual detail, quote or number from THIS content, the memorable line the speaker said rather than "he talked about money," and uses the speaker's own words when they are already perfect.
- Bullets carry insight over inventory: "He picked a language he doesn't even like because the ecosystem fits agents" beats "he uses Go for CLIs." A contradiction or reversal is the wisdom.
- Bullets run mostly 8-16 words with varied length, mixing short and medium, with periods between thoughts rather than em-dashes. A bullet that needs two or three short sentences, or a verbatim quote, may run longer, and no bullet exceeds 25 words.
- When the content has human moments (burnout, doubt, or something that moved the speaker), the extraction includes them as wisdom too, even when they aren't "technical."
- The speaker's genuinely hot contrarian takes ("screw MCPs", "X is dead", "Y is overhyped") appear undiluted.
- "Quotes That Hit Different" appears when the content has quotable moments, and "First-Time Revelations" when it has genuinely new ideas.
- At Comprehensive, breadth wins: every significant wisdom domain gets its own section, and no sections are merged to save space. If the content supports 15 sections, there are 15.
- Every level uses the same voice and quality bar and only the structure changes, so an Instant bullet hits as hard as a Comprehensive one.
- Before delivery it passes every check in § Output format's Quality Check.

## Anti-criteria

- No sample string from `References/VoiceCalibration.md` ever appears in an extraction; those strings are calibration only, and one appearing means the reference was copied instead of the content extracted.
- No bullet at Level 1 (documentation voice: "The speaker discussed…") or Level 2 (compressed smart-bullet with em-dashes); both fail.
- No genuinely hot contrarian take from the speaker is lost or diluted, and no spicy take or stunning moment found in an early pass is dropped before the final; losing one between drafts is a failed extraction.
- No inventory section: a bare list of facts isn't wisdom. Go deeper on why the choices matter, or merge it into a philosophy section.
- Nothing that belongs together is split across sections.

## Inputs

| Source | Method |
|--------|--------|
| YouTube URL | `fabric -y "URL"` to get the transcript; when `fabric -y` returns no transcript, `bun LIFEOS/TOOLS/GeminiWatch.ts "URL" --out <file>` has Gemini watch the video from its URL and return a near-verbatim transcript; a 429 is a rate limit to wait out, not a path to retry |
| Article URL | Pull the raw HTML with `curl` (or `fetch`) and extract the body text in a `.ts` file or `bun -e`, skipping nav and footer chrome; when a plain fetch cannot render the page, BrightData may fetch it within that site's terms, and a site that refuses automated access is reported, not worked around |
| File path | Read the file directly |
| Pasted text | Use directly |

WebFetch is never the article source: it returns a small model's summary, not the page, so quotes and numbers taken from it break the first Ideal State bullet.

The depth level comes from the request: "extract wisdom (fast)" or "extract wisdom at comprehensive level", or just "extract wisdom" for Full.

## Output format

| Level | Sections | Bullets/Section | Closing sections | When |
|-------|----------|----------------|------------------|------|
| **Instant** | 1 | 8 | None | Quick hit. One killer section. |
| **Fast** | 3 | 3 | None | Skim in 30 seconds. |
| **Basic** | 3 | 5 | One-Sentence Takeaway only | Solid overview without the deep cuts. |
| **Full** | 5-12 | 3-15 | One-Sentence Takeaway + If You Only Have 2 Minutes + References & Rabbit Holes | The default. Complete extraction. |
| **Comprehensive** | 10-15 | 8-15 | All three above + Themes & Connections | Maximum depth. Nothing left behind. |

**One-Sentence Takeaway** — the single most important thing from the entire piece, in 15-20 words.

**If You Only Have 2 Minutes** — the 5-7 absolute must-know points. The cream of the cream.

**References & Rabbit Holes** — people, projects, books, tools, and ideas mentioned that are worth following up on, with brief context for each.

**Themes & Connections** (Comprehensive only) — 3-5 throughlines that connect multiple sections. The deeper patterns the speaker may not realize they're revealing. Synthesis, not summary.

```markdown
# EXTRACT WISDOM: {Content Title}
> {One-line description of what this is and who's talking}

---

## {Dynamic Section 1 Name}

- {bullet}
- {bullet}
- {bullet}

## {Dynamic Section 2 Name}

- {bullet}
- {bullet}

[... more dynamic sections ...]

---

## One-Sentence Takeaway

{15-20 word sentence}

## If You Only Have 2 Minutes

- {essential point 1}
- {essential point 2}
- {essential point 3}
- {essential point 4}
- {essential point 5}

## References & Rabbit Holes

- **{Name/Project}** — {one-line context of why it's worth looking into}
- **{Name/Project}** — {context}
```

### Quality Check

Deterministic checks to run on the draft before delivering. The `extractwisdom-contract` eval does not assert these counts; it checks that insights come from the source and that a contrarian take appears:

- [ ] Section count matches depth level (Instant=1, Fast/Basic=3, Full=5-12, Comprehensive=10-15)
- [ ] Closing sections match depth level (the Closing sections column above)
- [ ] No bullet starts with "The speaker" or "It was noted that"
- [ ] No more than 3 bullets per section start with "He" or the speaker's name
- [ ] No bullet exceeds 25 words
- [ ] "If You Only Have 2 Minutes" bullets are each under 20 words

## Gotchas

- For long content, save the transcript to a working file and chunk it — don't extract from a 3-hour transcript in one pass.

## References

- `References/VoiceCalibration.md` holds the three-level voice ladder; every bullet lands at Level 3.
- The voice is the principal's; when the install has `LIFEOS/USER/PRINCIPAL/WRITINGSTYLE.md`, that file is the canonical voice reference.
