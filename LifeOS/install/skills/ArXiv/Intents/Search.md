# Search — Find Papers by Topic or Keywords

Search arXiv for papers matching specific topics, keywords, or author names.

## Ideal State

- The query is the user's intent in arXiv query syntax: topic/keywords as `all:{query}` (or `ti:{query}+AND+abs:{query}` for tighter matches), authors as `au:{name}`, combinations chained with `AND`/`OR`, spaces URL-encoded as `+` and special chars as `%XX`.
- Recent means recently submitted: the query limits `submittedDate` to the last 12 months (or the window the user asks for) and sorts by relevance, so the most relevant work from the whole window is fetched, not just the newest few days of a busy topic. Each kept paper is checked against its `<published>` date, so old papers with minor edits never count as recent.
- Papers older than 12 months (unless the user specifically asks for older work) and papers with low relevance (title/abstract don't match intent) are left out, and the reply says what was left out and why, so a seminal older paper is never hidden silently.
- The top 3-5 results carry the AlphaXiv summary when the overview returned 200 and the abstract when it returned 404.
- Results use the Latest format, relevance-ordered (most relevant first, not just most recent), with a "Related searches" section at the end when the query could be refined.

## Anti-criteria

- Never surfaces old papers with minor edits as recent work, and never calls an update a new submission.
- Never presents an AlphaXiv overview as retrieved when it was unavailable (404).

## Output format

Latest.md § Output format, plus the "Related searches" section:
```markdown
## Related Searches
- Try `cat:cs.CR+AND+all:prompt+injection` for security-focused results
- Try `au:Smith+AND+cat:cs.CL` to narrow by category
```

## Inputs

User provides a search query: topic, keywords, author name, or a combination.

## Tool contract

```bash
curl -sL "https://export.arxiv.org/api/query?search_query=QUERY+AND+submittedDate:%5BSTART0000+TO+END2359%5D&sortBy=relevance&sortOrder=descending&start=0&max_results=30"
```

`START` and `END` are `YYYYMMDD` dates bounding the window (default: 12 months ago to today). The brackets stay encoded as `%5B`/`%5D`: curl reads raw `[]` as a glob and the request fails silently. When the user asks for the newest matches rather than the best ones, sort by `submittedDate` instead, and say the results are newest-first.

Extract the fields listed in Latest.md § Tool contract. AlphaXiv overview: SKILL.md § Quick Reference.

## Examples

- "papers on prompt injection" → `all:prompt+injection`
- "LLM agent papers by Shunyu Yao" → `au:Yao+AND+all:agent`
- "retrieval augmented generation security" → `ti:retrieval+augmented+generation+AND+abs:security`
