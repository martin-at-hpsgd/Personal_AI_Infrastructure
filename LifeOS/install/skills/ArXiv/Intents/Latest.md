# Latest — Browse Recent Papers by Category

Get the most recent papers in a category or set of categories.

## Ideal State

- The papers come from the arXiv categories the user's topic maps to (the category table in SKILL.md § Quick Reference); a category the user names directly is used as-is, and an ambiguous topic uses multiple categories joined with OR.
- The papers are new submissions: the query sorts by `submittedDate`, and every paper's date is its `<published>` date.
- Each paper shows its title (newlines stripped), paper ID, submission date from `<published>`, the first 3 authors plus "et al." if more, a 2-3 sentence abstract or AlphaXiv summary, a one-sentence "Why it matters" on relevance to our work, the arxiv link, and the AlphaXiv link when an overview exists.
- The top 3-5 papers, chosen by title/abstract relevance to our work, carry the AlphaXiv summary when the overview returned 200 and the abstract when it returned 404.
- The results are a scannable list that leads with the papers most relevant to our work and ends with a "Papers worth reading" section: 2-3 papers, each with a brief explanation of why it matters.

## Anti-criteria

- Never calls an update a new submission: `lastUpdatedDate` includes edits to old papers, so newness is judged by the `<published>` date.
- Never presents an AlphaXiv overview as retrieved when its fetch returned 404.

## Output format

```markdown
## Latest in {Category} — {Date}

### {Paper Title}
**{Authors}** | {Date} | `{paper_id}`
{2-3 sentence abstract or AlphaXiv summary}
**Why it matters:** {1 sentence on relevance to our work}
{arxiv link} | {AlphaXiv link, when an overview exists}

---
[... more papers ...]

## Papers worth reading
- {Paper Title}: {why it matters}
```

Link formats: arxiv `https://arxiv.org/abs/{paper_id}`, AlphaXiv `https://alphaxiv.org/abs/{paper_id}`.

## Inputs

User provides a topic area (e.g., "AI agents", "LLM security", "machine learning") or a category.

## Tool contract

```bash
curl -sL "https://export.arxiv.org/api/query?search_query=cat:CATEGORY&sortBy=submittedDate&sortOrder=descending&start=0&max_results=15"
```

For multiple categories:
```bash
curl -sL "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.MA&sortBy=submittedDate&sortOrder=descending&start=0&max_results=15"
```

Extract from each `<entry>`:
- `<title>` — paper title (strip newlines)
- `<id>` — extract paper ID from URL (e.g., `2603.12345`)
- `<published>` — submission date
- `<summary>` — abstract (first 2-3 sentences)
- `<author><name>` — first 3 authors + "et al." if more
- `<arxiv:primary_category>` — primary category

AlphaXiv overview: SKILL.md § Quick Reference.
