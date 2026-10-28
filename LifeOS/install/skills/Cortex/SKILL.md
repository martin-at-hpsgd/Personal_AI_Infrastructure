---
name: Cortex
metadata:
  short-description: "Search and manage the typed Knowledge Archive; recall prior sessions, conversations, and ISAs."
version: 2.2.1
evals:
  manual:
    reason: "memory retrieval and archive management must be checked against the requested prior work and the authorized corpus"
    falsifier: "the reviewer finds the result misses a material relevant record, attributes content to the wrong source, or proposes an unauthorized write"
description: LifeOS memory, prior-session recall, and learning capture. USE WHEN capture this learning, document this learning, what did we learn recently, recent learnings, cortex, knowledge, knowledge base, search knowledge, what do we know about, archive, harvest, knowledge status, develop note, add to knowledge, add a people or company note, ingest, contradictions, knowledge graph, retrieve, mine conversations, distill, weekly digest, cortex digest, context search, prior work, recall, remember, remember when we, previous sessions, context recovery, what did we do, what did we do with, we just worked on, didn't we already fix, why did we change, find session, search history, resume, pick up where we left off, cold start, yesterday's work, last week, the one about. NOT FOR published-content search, or mining one piece of content for the system.
argument-hint: [search|add|harvest|develop|ingest|distill|recall|contradictions|graph|retrieve|mine|<query>]
---

# Cortex

**Contents:** Ideal State · Anti-criteria · Intent Routing · Tool contract · Data & Config · Gotchas · Examples

Search and manage the typed Knowledge Archive, recall prior LifeOS work, or capture and digest problem-solving learnings. Every archive note is typed into one of six canonical entity domains (`KnowledgeSchema.ts` CANONICAL_TYPES): People (individuals, public figures, contacts with relationship context), Companies (organizations, businesses, teams with structure and positioning), Ideas (concepts, theses, frameworks, thought patterns across work and life), Research (findings, studies, deep-dive topics with source citations and evidence), Books (published works with claim summaries, key quotes, and implications), and Blogs (blog posts and articles with takeaways, relationships to other notes).

## Ideal State

- A recall answer names the prior sessions, ISAs and decisions that match, ranked, each with its date and path, and states what was decided or done there rather than only the topic; when nothing matches, it says so and names the query and the sources searched.
- An archive search returns a deduplicated table of matching notes (title, domain, status, tags), or an explicit "no matches" with a suggested next step; retrieve returns the top matching notes ranked, with compressed summaries.
- A captured learning tells the problem, assumption, reality, journey with its dead ends, solution and takeaway, filed under `LEARNING/SYSTEM/YYYY-MM/` or `LEARNING/ALGORITHM/YYYY-MM/`; a recent-history digest lists the files it read and says nothing they do not.
- All archive operations (`add`, `harvest`, `develop`, `ingest`) classify each note into one of the six canonical KNOWLEDGE note types and add typed cross-links (`related:` frontmatter) between notes to keep the graph connected: every new note carries the eight envelope fields and 2-4 typed `related:` links, each naming a slug that exists in the archive.
- Every result comes from the command's loaded deterministic tools, and any verification that was unavailable is named in the result as unavailable, never reported as passed.

## Anti-criteria

- Never proceeds on a partial load: a truncated read is not a successful load, and truncation warnings count anywhere in the output, not only at the `END CONTEXTLOAD` marker.
- A failed search is never taken to establish absence.
- No archive write drops the loaded schema, link, or approval requirements.
- The result never misses a material relevant record, attributes content to the wrong source, or proposes an unauthorized write.
- No personal configuration is kept inside this public skill.

## Intent Routing

| Request | Bundle | Delivers |
|---|---|---|
| `/knowledge` with no arguments | `status` | Health dashboard |
| Archive search, `/knowledge <query>` or `/knowledge search <query>` | `search` | Notes matching the query |
| `/knowledge add <type>` | `add` | A new note (People, Companies, Ideas, Research, Books, Blogs) |
| `/knowledge harvest` | `harvest` | KnowledgeHarvester run over all sources |
| `/knowledge develop` | `develop` | Seedlings surfaced and enriched |
| `/knowledge ingest <url-or-file>` | `ingest` | A note from the source, with ripple updates to related notes |
| `/knowledge contradictions` | `contradictions` | Conflicting claims across notes, reviewed |
| `/knowledge graph [slug]` | `graph` | Graph stats, or a traversal from `/knowledge graph <slug>` |
| `/knowledge retrieve <query>` | `retrieve` | Compressed context retrieval |
| `/knowledge mine` | `mine` | Memory candidates mined from recent conversations |
| `/knowledge distill` | `distill` | Weekly routed, cited digest of the archive |
| `/cortex recall <query>`, `/cs`, or "we just worked on", "what did we do with", "remember when we", "didn't we already fix" | `recall` | Prior work (sessions, ISAs, conversations, commits) by topic or date phrase, with what was decided and why |
| Uncertain routing or the whole reference | `full` | The complete guide |

| Intent | Trigger | File |
|--------|---------|------|
| **CaptureLearning** | "capture this learning", "document this problem", "write up what we learned" | `Intents/CaptureLearning.md` |
| **CheckRecent** | "what did we learn recently", "check recent history", "recent learnings", "digest the last N learnings" | `Intents/CheckRecent.md` |

These two run from their intent files, not a `ContextLoad.ts` bundle; both work on the LEARNING store (`LIFEOS/MEMORY/LEARNING/`) and saved research, never the KNOWLEDGE archive.

`/cortex <args>` and legacy `/knowledge <args>` route identically. Arguments that do not name a subcommand are archive searches.

| File | Read when |
|------|-----------|
| `References/CompleteGuide.md` | loading `full`, or reading a command section directly when `ContextLoad.ts` fails; `Context.json` maps its headings to the bundles above |

## Tool contract

Before executing any Cortex command, load its bundle from the Intent Routing table (or `full`, when the command does not fit a listed bundle or relevance is uncertain) with the deterministic loader:
`bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/ContextLoad.ts" Cortex load BUNDLE`

It returns the selected command instructions and mandatory archive constraints together, with source hashes. Follow every returned requirement. When the loader fails, read `References/CompleteGuide.md` and the relevant command section directly. Paths in the preserved guide are relative to the skill root. Already-loaded, unchanged sections need no second read; after compaction or a source change, load the relevant bundle again.

For bundle reads, set the shell tool output budget to 30000 tokens. With a code-mode wrapper, also set its output budget to 30000.

Use `list` to discover sections and bundles, and `search "query"` to search the preserved guide. When a search finds nothing, inspect the index, broaden the query, or load `full`.

## Data & Config

The `distill` command reads its optional configuration from `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Cortex/DistillConfig.json`, as its loaded instructions describe. Keep personal configuration outside this public skill.

## Gotchas

- None recorded at skill level yet. Command-level gotchas live in `References/CompleteGuide.md` § Gotchas and load with every bundle.

## Examples

**Example 1: Recall prior work**
```
User: "recall the invoice for the Texas trip"
→ recall bundle
→ Ranked prior sessions and ISAs with dates and paths, and what each one settled
```

**Example 2: Add a person**
```
User: "add people Jane Doe"
→ add bundle
→ A People note with the eight envelope fields and 2-4 typed related: links to notes that exist
```

**Example 3: Search the archive**
```
User: "what do we know about prompt injection?"
→ Routes to search — 3-pass (lexical + frontmatter + wikilink) over MEMORY/KNOWLEDGE/
→ Returns table of matching notes with domain, status, tags
```

**Example 4: Ingest a source**
```
User: "/knowledge ingest https://example.com/article"
→ Fetches the source, classifies entity type, creates primary note with typed related: links
→ Ripple pass proposes updates to existing related notes; user approves; MOCs regenerated
```

**Example 5: Status check**
```
User: "knowledge status"
→ Runs KnowledgeHarvester.ts status
→ Shows domain note counts, orphan wikilinks, stale seedlings, time since last harvest
```
