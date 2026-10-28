---
name: ArXiv
evals:
  manual:
    reason: "This intent uses live paper and overview tools rather than a skill-owned parser; each delivered paper summary needs source comparison until a representative retrieval fixture exists."
    falsifier: "A returned paper ID, author, submission date, or quoted contribution disagrees with arXiv; an update is called a new submission; or an unavailable overview is presented as retrieved."
metadata:
  short-description: "Search and retrieve arXiv papers by topic, category, or ID, with AlphaXiv overviews. Use Research for general web research."
version: 1.1.2
description: "Search and retrieve arXiv academic papers by topic, category, or paper ID — with AlphaXiv-enriched AI-generated overviews. Uses arXiv Atom API across cs.AI/cs.LG/cs.CL/cs.CR/cs.MA/cs.SE/cs.IR. Three intents: Latest, Search, Paper. USE WHEN arxiv, papers, latest papers, research papers, recent ML papers, paper lookup, summarize paper, latest LLM papers, AI safety papers, cs.AI latest. NOT FOR general research (Research), URL parsing, or annual reports."
---

# ArXiv

Searches and retrieves arXiv academic papers by topic, category, or paper ID, and pulls AlphaXiv's AI-generated overviews when a paper has one. Three intents: Latest, Search, Paper. No API keys needed.

## Ideal State

- Every paper ID, title, author list and date matches arXiv, and newness is judged by `<published>`, so an edited old paper is never shown as a new submission.
- An AlphaXiv overview is used only when its fetch returned 200; otherwise the answer says it worked from the abstract or full text.
- Every result links to arXiv and says in one line why it matters to the principal's interests (the focus areas in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ArXiv/PREFERENCES.md`; with no file, judge relevance from the request), most relevant first.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Latest** | "latest papers in X", "new papers on X", "what's new in AI research" | `Intents/Latest.md` |
| **Search** | "search arxiv for X", "find papers about X", "arxiv papers on X" | `Intents/Search.md` |
| **Paper** | arxiv URL, paper ID like `2401.12345`, "explain this paper" | `Intents/Paper.md` |

## Quick Reference

Shared by all three intents. Each intent's exact query is in its own Tool contract.

**arXiv API** (no auth):
- Base: `https://export.arxiv.org/api/query`
- Search fields: `ti:` (title), `au:` (author), `abs:` (abstract), `cat:` (category), `all:` (everything)
- Booleans: `AND`, `OR`, `ANDNOT`
- Sort: `sortBy=submittedDate&sortOrder=descending` returns new submissions, newest first
- Pagination: `start=0&max_results=10`

**AlphaXiv overview** (no auth):
- `curl -s "https://alphaxiv.org/overview/{PAPER_ID}.md"`
- A 200 returns a structured markdown analysis optimized for language models. Not all papers have overviews: a 404 means the analysis is not yet generated.
- AlphaXiv uses the latest version, so the lookup takes the bare numeric ID (e.g., `2603.12345`, never `2603.12345v2`).

**Categories** (topic words map a user's topic to a category; an ambiguous topic uses several joined with OR):

| Category | Name | Topic words |
|----------|------|-------------|
| `cs.AI` | Artificial Intelligence | AI, artificial intelligence |
| `cs.LG` | Machine Learning | machine learning, ML, deep learning |
| `cs.CL` | Computation and Language (NLP/LLMs) | LLMs, NLP, language models |
| `cs.CR` | Cryptography and Security | security, cybersecurity |
| `cs.MA` | Multi-Agent Systems | agents, multi-agent: query `cs.MA+OR+cs.AI` |
| `cs.SE` | Software Engineering | software engineering |
| `cs.IR` | Information Retrieval | information retrieval, RAG |
| `cs.RO` | Robotics | robotics |
| `cs.CV` | Computer Vision | computer vision |

The principal's priority categories are listed in `PREFERENCES.md` (see Data & Config); with no file, use the categories the request names.

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ArXiv/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md, configurations and resources override the defaults; when it is absent, the defaults stand.

## Gotchas

- arXiv API requires HTTPS and `-L` (follows redirects). HTTP 301s to HTTPS silently.
- The arXiv API returns Atom XML, not JSON. Parse with text processing, not `jq`.
- `lastUpdatedDate` includes edits to old papers. For truly new submissions, check `<published>` dates.
- AlphaXiv overviews are AI-generated summaries. Great for quick understanding, but verify claims against the actual paper for anything you'd cite.
- arXiv API rate limit is 3 seconds between calls. Batch your queries.
- `max_results` caps at 2000. For broader sweeps, paginate with `start`.
- Category search (`cat:cs.AI`) returns papers with that as primary OR cross-listed category.

## Examples

**Example 1: Latest papers in a category**
```
User: "what's new in AI safety papers this week"
→ Latest intent
→ This week's new cs.AI submissions by <published> date: titles, authors, abstracts, links, and a Papers worth reading pick
```

**Example 2: Topic search**
```
User: "search arxiv for prompt injection defenses"
→ Search intent (query all:"prompt injection" with boolean refinement)
→ Ranked recent matches with abstracts, plus related searches
```

**Example 3: Single paper lookup**
```
User: "explain this paper: 2401.12345"
→ Paper intent
→ Summary from the AlphaXiv overview (or the abstract when it 404s), key contributions, a worth-reading verdict, and the PDF link
```
