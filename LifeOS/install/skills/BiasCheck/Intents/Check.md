# Check

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format

A structured three-layer bias analysis of one source that separates what the data actually supports from what was editorialized on top.

## Ideal State

- When the primary input is journalism, commentary, or a secondary citation of a study/report/dataset/paper, the underlying primary source was fetched before the analysis, or, when one round of WebSearch could not locate it, "primary source not publicly accessible" is documented in the methodology section as publication-availability bias (no silent skip).
- Every quoted tell comes from the full text of the artifact as read, never from a tool's summary of it.
- The methodology line is filled out for the primary source (or the article itself if there is no separate primary): sample frame, sample size, dates, funding/source, instrument availability and methodology type, with any fact not stated listed as "not disclosed".
- Layers 1, 2 and 3 are clearly separated: biases inside the data, source-organization biases, and biases added by the journalism/commentary; Layer 3 is skipped, with a one-line note, only when the input IS the primary source.
- Every bias claim ties to a specific tell from the artifact (a quoted phrase, a sample-frame fact, a missing disclosure), and each Layer 1 category that fires gets 2–4 sentences anchored to a specific fact about this study.
- A headline that claims more than the article body or the source is flagged whenever present, because most readers see only the headline.
- The supported-vs-not-supported split is present and concrete: a generous, charitable reading of what the data actually supports (a defensible version of the claim), and the claims the data cannot carry, each paired with one of the Layer-1/2/3 findings.
- The bottom line is 2–3 sentences (one paragraph) in plain language that states what the source actually is, the honest version of its claim, and the multiplier on top of the data, not just what's wrong with it.
- The Sources list includes URLs for every primary, secondary, and methodology document fetched.
- The report is Markdown in the fixed section structure under Output format, and its length scales with source complexity: a single-claim tweet gets ~200 words; a vendor-funded study + viral article gets 800–1500.
- Tone is plain and specific, with no vibes: every judgment in the report rests on a stated tell or fact from the artifact.

## Anti-criteria

- No hedging vocabulary ("could potentially," "may suggest," "could potentially be biased"). Diagnose or don't. The reader gets to disagree, but they should know what the analyst actually thinks.
- No generic "vendor research has bias" finding: name the specific tell. A big-consultancy or analyst-firm report is not dismissed because the producer sells consulting; a firm that sells AI workforce consulting and concludes that companies need AI workforce consulting has a structurally compromised conclusion, but the data may still be useful.
- No conflating Layer 1 and Layer 3: a bad headline does not make the underlying data bad, and a flawed study does not make the journalism dishonest.
- No claims beyond the sources actually read: no drive-by claims about an org's other reports that were not fetched, no "they always do X".
- No audit of the author's biography or track record; the skill audits the artifact. "Who is this writer" goes to Research or a dedicated OSINT/entity-investigation skill.
- No audit of an input that fails the sufficiency check in Inputs.
- No rabbit hole hunting for the primary source: stop after one round of search, because documenting unavailability IS valid output.

## Inputs

| Shape | Handling |
|-------|----------|
| Single URL | Read the full page text (Tool contract), extract content + any cited sources |
| File path | `Read` the file; if PDF, use `Read` with `pages:` param for large PDFs |
| Raw text paste | Use directly |
| Mixed (URL + commentary) | Treat URL as primary source; treat commentary as context, not as an additional source |
| Two URLs | Confirm intent first (ambiguity threshold below); then audit both |

Every input normalizes to **primary content (what was given) + sources cited within (to fetch per the Tool contract)**.

**Sufficiency check**, before fetching anything:

1. **Is there a source?** A URL, file path, or substantive text body (≥ ~50 words) must be present. A bare claim with no source attached ("is the moon landing fake biased?") fails: ask for a source or redirect.
2. **Is it the right tool?** Pure opinion piece with no empirical scaffolding → redirect to a psychological author-analysis skill. Pure claim about a person's character → redirect to a dedicated OSINT/entity-investigation skill or Research. A study, dataset, survey, statistical claim, or article reporting any of those → proceed.
3. **Ambiguity threshold:** one URL with no further context → proceed (default interpretation: audit it). Two URLs without a stated relationship → ask one question: are these (a) one analyzes the other, or (b) two separate sources to compare? Then proceed.

If the input is not sufficient, emit ≤3 questions with a `proceed` override and halt.

## Tool contract

**Reading a URL.** Pull the raw HTML with `curl` (or `fetch`) and extract the body text with `bun -e`, then read it whole. X URLs go through `skills/X/Tools/read.ts` first.

**Identification heuristics** for a primary source behind the input:

- Phrases like "according to a study by X," "X's research found," "a new survey from X," "X report shows," "data from X"
- Linked PDFs, vendor research landing pages, press releases
- Specific named statistics ("99% of CEOs say...") that imply a survey
- Academic citations (DOI, arXiv ID, journal name)

**Fetch order:**

1. Try the direct link if one is given, read as above.
2. If the link is a landing page or table-of-contents, follow it and try to surface the actual report or methodology PDF.
3. If no direct link exists, use `WebSearch` to find the primary source by name + author + topic.
4. If after one round of WebSearch you cannot locate it, that becomes a finding: "primary source not publicly accessible" goes in the methodology section as publication-availability bias.

## Gotchas

- **WebFetch returns a small model's summary, never the content.** An audit built on it quotes a summary, not the artifact, which breaks the quoted-tell bullet above. It is never cited as having read the page.

## Output format

Category names, definitions and tells for all three layers come from `BiasTaxonomy.md`; not every category fires for every source.

```markdown
# Bias Analysis: {short topic-based title}

**Source(s) examined**
- Reporting source: {URL or file path}
- Underlying primary source: {URL, citation, or "not publicly accessible"}

**Methodology of the underlying study**
- Sample frame: {who was surveyed/measured: population, role, geography, recruitment method}
- Sample size: {N total, plus any meaningful sub-N, e.g. US executive subset}
- Fieldwork dates: {when fieldwork ran; when the report was published}
- Funding/producer: {who paid for the work; who produced it; what they sell}
- Instrument availability: {public / topline-only / not disclosed}
- Methodology type: {survey, observational, RCT, retrospective, cross-sectional, longitudinal}

---

## Layer 1 — Biases inside the data

- **{Category name}.** {2–4 sentence specific finding tied to this study.}
- **{Category name}.** {finding}
- ...

## Layer 2 — Source-organization biases

- **{Category name}.** {finding}
- ...

## Layer 3 — Biases added by the journalism/commentary

- **{Category name}.** {finding}
- ...

*(Skip Layer 3 entirely with a one-line note if the input IS the primary source.)*

---

## What the data actually supports

- {Defensible claim 1}
- {Defensible claim 2}
- ...

## What the data does NOT support

- {Overclaim 1, tied to a Layer 1/2/3 finding}
- {Overclaim 2}
- ...

---

## Bottom line

{2–3 sentences. Honest reframe in plain language.}

**Sources**
- [Reporting source]({URL})
- [Primary source]({URL or note about unavailability})
- [Additional context]({URL})
```
