# Paper — Deep-Dive a Specific Paper

Get a structured overview of a specific arXiv paper using AlphaXiv enrichment with arXiv metadata fallback.

## Ideal State

- Whatever form the input took (arXiv abs or pdf URL, AlphaXiv URL, bare ID with or without a version suffix), the paper resolves to its numeric ID, and the AlphaXiv lookup uses that ID with any version suffix removed.
- The Overview's source is the best one available, in this order: the AlphaXiv overview when it returned 200, then the AlphaXiv full text, then the abstract alone, in which case the reply tells the user they can read the full PDF at `https://arxiv.org/pdf/PAPER_ID`.
- Title, authors, abstract, categories, published date, updated date, and DOI if present come from arXiv metadata in every case, whatever the overview returned.
- The reply follows the Output format: full author list, published date and categories, arXiv / PDF / AlphaXiv links, an Overview, 3-5 Key Contributions bullets on what's new/important, Relevance to Our Work, and an honest Worth Reading? verdict (skim, read, or skip, and why).

## Anti-criteria

- Never returns a paper ID, author, submission date, or quoted contribution that disagrees with arXiv.
- Never calls an update a new submission.
- Never presents an AlphaXiv overview as retrieved when it was unavailable (404).

## Output format

```markdown
# {Paper Title}

**Authors:** {full author list}
**Published:** {date} | **Categories:** {cats}
**Links:** [arXiv](https://arxiv.org/abs/ID) | [PDF](https://arxiv.org/pdf/ID) | [AlphaXiv](https://alphaxiv.org/abs/ID)

## Overview
{AlphaXiv overview or abstract-based summary}

## Key Contributions
{3-5 bullets on what's new/important}

## Relevance to Our Work
{How this connects to LifeOS, AI agents, security, LLM infrastructure, or the user's interests}

## Worth Reading?
{Honest assessment: skim, read, or skip — and why}
```

## Inputs

User provides one of:
- arXiv URL (`https://arxiv.org/abs/2603.12345` or `https://arxiv.org/pdf/2603.12345`)
- AlphaXiv URL (`https://alphaxiv.org/abs/2603.12345`)
- Paper ID (`2603.12345` or `2603.12345v2`)

## Tool contract

AlphaXiv overview, bare numeric ID: SKILL.md § Quick Reference.

arXiv metadata:
```bash
curl -sL "https://export.arxiv.org/api/query?id_list=PAPER_ID"
```

AlphaXiv full text, when the overview 404s:
```bash
curl -s "https://alphaxiv.org/abs/PAPER_ID.md"
```
