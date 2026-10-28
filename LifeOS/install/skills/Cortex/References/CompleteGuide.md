# Cortex Skill

**Contents:** What It Does · How It Works · Intent Routing · status (default, no args) · search <query> · add <type> · Canonical Linking Requirement (MANDATORY) · harvest · develop · ingest <url-or-file> · contradictions · graph [slug] · retrieve <query> · mine · distill · recall <query> · Gotchas · Examples

<!-- Six canonical types (People, Companies, Ideas, Research, Books, Blogs) throughout, matching KnowledgeSchema.ts CANONICAL_TYPES — public PR #2042 / issue #1986, @hjbrandt -->
<!-- public issue #1991, @xmasyx — the description's NOT FOR no longer disclaims URL/YouTube ingestion: this skill ships its own `## ingest <url-or-file>` intent, and the private harvester pipeline it used to point at is absent from public installs. -->

## What It Does

Operate Cortex, the LifeOS memory system, from one skill. Two halves: the **Knowledge Archive** — a curated, typed graph of notes across six entity domains (People, Companies, Ideas, Research, Blogs, Books), every note shipping typed `related:` cross-links so the archive is a connected graph, not a pile of files — and **recall** — finding prior work (sessions, ISAs, conversations) by topic or date phrase. Operations cover search, add, harvest, develop, ingest, contradiction-finding, graph traversal, compressed retrieval, conversation mining, the weekly distill pass, and session recall.

## How It Works

Manage the LifeOS Knowledge Archive at `~/.claude/LIFEOS/MEMORY/KNOWLEDGE/`. Each operation routes through a subcommand below; notes follow the archive schema. Every new Knowledge note must ship with typed cross-links (§ Canonical Linking Requirement).

**Archive schema:** `~/.claude/LIFEOS/MEMORY/KNOWLEDGE/_schema.md`

**Hard rule — never write KNOWLEDGE/ directly.** All writes route through this skill (`add`, `harvest`, `ingest`, `develop`) — never `cp`, `mv`, `Write`, or `Edit` straight into the directory, even during migration or bulk import. The skill's operations apply typed frontmatter, cross-links, and domain classification; raw filesystem writes skip those steps and corrupt the graph silently (broken links don't fail loudly — they produce phantom entries retrieval misses). Nothing blocks a raw write. The `KnowledgeWriteGuard` PostToolUse hook is advisory: after a Write/Edit/MultiEdit to a note it reports schema violations and never blocks; Bash `cp`/`mv` are not checked at write time; the SessionEnd `KnowledgeConformance` pass reports drift afterwards. This rule holds by discipline, not by a gate. Migration tooling MUST call this skill per chunk, never shell out to `cp`. The one sanctioned exception is the Algorithm's LEARN phase, which writes to `KNOWLEDGE/` directly because it holds the best context and applies the same schemas (see Gotchas).

## Intent Routing

The routing table lives in `SKILL.md` § Intent Routing; each subcommand there loads the H2 section of the same name below. `/cortex <args>` and legacy `/knowledge <args>` route identically, and arguments that name no subcommand are a search.

---

## status (default, no args)

**Done looks like:** the health dashboard rendered — per-domain note counts, orphan wikilinks, stale seedlings, and time since last harvest.

Run the harvester status command and display results:

```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeHarvester.ts status
```

---

## search <query>

Search the Knowledge Archive for notes matching `$ARGUMENTS`.

**Done looks like:** a deduplicated table of matching notes (title, domain, status, tags) drawn from all three passes, or an explicit "no matches" with a suggested next step.

**Step 1 — Lexical search:**
```bash
rg -i "$ARGUMENTS" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md -l
```

**Step 2 — Frontmatter search (tags and titles):**
```bash
rg -i "title:.*$ARGUMENTS|tags:.*$ARGUMENTS" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md -l
```

**Step 3 — Wikilink search:**
```bash
rg "\[\[.*$ARGUMENTS.*\]\]" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md -l
```

Deduplicate results across all three. For each match, read the first 5 lines of frontmatter to show title, domain, status, tags.

Present results as a table:
```
| Note | Domain | Status | Tags | Relevance |
```

---

## add <type>

Create a new note manually in the specified entity type.

**Done looks like:** a schema-valid note written with all eight envelope fields and 2-4 typed `related:` links, every related slug verified to exist, and the type's MOC regenerated.

1. Validate type is one of: People, Companies, Ideas, Research, Books, Blogs
2. Ask for a title (or use remaining args after type)
3. Generate kebab-case filename from title
4. Find 2-3 related notes before writing, with the searches in § Canonical Linking Requirement below; they become the note's `related:` array.
5. Create the note with proper frontmatter from `_schema.md` — the validator (`LIFEOS/TOOLS/KnowledgeSchema.ts` ENVELOPE) requires all EIGHT of: `id` (mint via `mintId(slug, created)` — `kb_` + 12 hex chars), `type`, `title`, `tags` (min 1), `quality` (0-10), `created`, `updated`, `convention: kb-v3` — plus type-specific body sections. A note built from the old six-field list can never validate (public issue #1678, @christauff). Set `created:` and `updated:` to today's date from `date +%Y-%m-%d` — archive-entry dates, never a source's publication date (public PR #1604, @asdf8675309).
6. Write the file to `KNOWLEDGE/<Type>/<kebab-case-title>.md` — slug max 60 chars
7. Verify every slug in `related:` exists in the archive before saving
8. Regenerate the type's MOC:
```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeHarvester.ts index
```

**Topic is a tag, not a type.** A security insight is an Idea with a `security` tag. A security company is a Company with a `security` tag. The entity type determines the schema; the tag determines the topic.

## Canonical Linking Requirement (MANDATORY)

**Every new Knowledge note must ship with typed cross-links.** This is not optional. The normative contract is `_schema.md` (regenerated by the schema tools): every note carries typed `related:` links naming the target note and the relationship type, so the archive is a graph, not a pile.

**Every write must include:**

1. **`related:` frontmatter array** — 2-4 typed entries linking to other Knowledge entries (any domain: People, Companies, Ideas, Research, Books, Blogs)
2. **Body wikilinks** — 1-3 `[[slug]]` references woven into the prose where natural (Implications, Evidence, or Context sections)

**9 relationship types** (pick the most accurate, prefer specific over generic):

| Type | Meaning |
|------|---------|
| `related` | Generic association (default only if no better fit) |
| `supports` | Provides evidence for the linked note |
| `contradicts` | Conflicts with the linked note |
| `extends` | Builds upon the linked note |
| `part-of` | Component of a larger whole |
| `instance-of` | Example of a pattern |
| `caused-by` | Result of the linked note |
| `preceded-by` | Came before temporally |
| `derived-from` | Distilled from the linked source note (e.g. blog → idea) |

**Frontmatter format:**
```yaml
related:
  - slug: other-note-slug
    type: extends
  - slug: another-note-slug
    type: supports
```

**How to find related notes before writing:**
```bash
# By topic/keyword
rg -l "TOPIC" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md

# By tag overlap
rg "^tags:.*TAG" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md -l

# For People/Companies — grep by name
rg -l "Person Name" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/
```

**Enforcement (by the writer, not by code):** the schema marks `related` optional (`LIFEOS/TOOLS/KnowledgeSchema.ts`) and the `KnowledgeWriteGuard` hook only reports, so nothing rejects a note without links. The writer owns this:
- Writes that skip `related:` are incomplete and must be fixed before the skill/intent returns success
- The `ingest` workflow runs this as part of the ripple pass
- The Algorithm LEARN phase includes this in its knowledge capture step
- All agents writing Knowledge entries must follow this rule — it is part of the schema, not an optional enhancement

---

## harvest

**Done looks like:** new candidates pulled from all sources and displayed, or an explicit "sources already up to date" when nothing was harvested.

Run the KnowledgeHarvester to pull new knowledge from all LifeOS sources:

```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeHarvester.ts harvest
```

Optionally accept `--source` filter: `/knowledge harvest work` or `/knowledge harvest memory`.

---

## develop

The weekly gardening intent. Surface seedling notes that are ready for enrichment.

**Done looks like:** every surfaced seedling either enriched and promoted after approval (status bumped, `updated:` set, affected MOCs regenerated), or the archive reported clean when no seedlings exist.

**Step 1 — Find seedlings:**
```bash
rg "^status: seedling" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md -l
```

**Step 2 — For each seedling:**
- Read the note
- Read related notes (follow wikilinks, search for same tags)
- Check if newer WORK/ ISAs or auto-memory entries have relevant context
- Enrich the note: add context, suggest wikilinks, flesh out content

**Step 3 — Present the diff to the user for approval.**

**Step 4 — If approved:**
- Write the updated note
- Promote status from `seedling` to `budding` (or `evergreen` if comprehensive)
- Update `updated:` to today's date from `date +%Y-%m-%d`; leave `created:` untouched
- Regenerate affected MOCs

If no seedlings exist, report archive is clean.

---

## ingest <url-or-file>

Ingest a source into the Knowledge Archive. This is the key Karpathy-inspired upgrade: reading a source doesn't just create one note — it **ripples updates through existing related notes**.

**Done looks like:** a primary note created with 2-4 typed `related:` links, the ripple plan reviewed and applied to related notes, contradictions flagged, `_log.md` appended, and MOCs regenerated.

**If no argument provided:** Show usage: `/knowledge ingest <url-or-file-path>`

### Fetch the source

- **URL:** Read the source text itself: `fabric -u <url>`, or `curl -sL <url>` with the body extracted in a `.ts` file. Never WebFetch, which returns a small model's summary of the page instead of its text (principal directive 2026-09-29), so a note built from it is built from a summary.
- **File path:** Use Read tool to read the local file.

Summarize the source in 2-3 sentences. Identify key entities, claims, and insights.

### Classify and create primary note

Determine entity type (People, Companies, Ideas, Research, Books, or Blogs) using the classification rules in `_schema.md`. Most ingested sources become Ideas.

Create the primary note using the schema for that type:
- Generate kebab-case slug from title (max 60 chars)
- Write to `KNOWLEDGE/<Type>/<slug>.md` with proper frontmatter
- Set `created:` and `updated:` to today's date from `date +%Y-%m-%d` — both record when the note entered the archive, **not** when the source was published. A stated publication date belongs in `source_date:`; never let it reach `created:`, and never guess a date the source does not state (public PR #1604, @asdf8675309)
- Include `source_url:` or `source_path:` in frontmatter
- Write the `related:` links § Canonical Linking Requirement demands into the primary note's frontmatter at creation time, not after; the ripple pass below finds them

### Ripple pass

Search for existing notes that relate to this new content:

```bash
# Search by extracted tags
rg -i "TAG1|TAG2|TAG3" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md -l --glob '!_*'

# Search by key entities/concepts mentioned
rg -i "ENTITY1|ENTITY2" ~/.claude/LIFEOS/MEMORY/KNOWLEDGE/ --type md -l --glob '!_*'
```

For each related note found (up to 10):
1. Read the note
2. Determine if the new source adds information, context, or contradicts existing claims
3. If yes, propose the specific update (add wikilink, add evidence, note contradiction)

**Present the ripple plan to the user:**
```
📥 INGEST RIPPLE PLAN:
  PRIMARY: Ideas/new-note-slug — "Title" (created)
  PRIMARY related: frontmatter links (MANDATORY):
    → Ideas/existing-note-1 — type: extends
    → Ideas/existing-note-2 — type: supports
    → People/person-slug — type: related
  RIPPLE (reverse-direction updates to existing notes):
    → Ideas/existing-note-1 — add body [[new-note-slug]] wikilink + add to its related: array (type: extends)
    → Ideas/existing-note-2 — update Evidence section with new data point + add to related:
    → Ideas/existing-note-3 — ⚠️ CONTRADICTION: new source says X, note says Y — type: contradicts
  NO CHANGE: Ideas/tangentially-related — mentioned same tag but no substantive connection
```

### Execute ripple updates

After the user approves the ripple plan. Every write to an existing note waits for that approval, cross-link additions included:
- **Related notes**: add reverse-direction `related:` entries to their frontmatter with appropriate types
- **Body wikilinks**: add `[[wikilinks]]` in existing prose where natural (not forced)
- Update `updated:` to today's date from `date +%Y-%m-%d` on modified notes; leave their `created:` untouched
- For contradictions: add a `> ⚠️ **Contradiction:** [note] claims X — see [[new-note]] for counter-evidence` callout, AND add `type: contradicts` in related: arrays

### Log and index

Append to `KNOWLEDGE/_log.md`:
```
## [YYYY-MM-DD] ingest | Title
- Source: <url or path>
- Primary: <Type>/<slug>
- Ripple: N notes updated, N contradictions flagged
```

Regenerate MOCs:
```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeHarvester.ts index
```

---

## contradictions

Find and review conflicting claims across Knowledge notes.

**Done looks like:** candidate pairs semantically reviewed, direct contradictions and superseded claims reported, and any approved resolutions written back with updated dates and regenerated MOCs.

### Get contradiction candidates

Run the KnowledgeHarvester contradiction finder:
```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeHarvester.ts contradictions
```

This outputs pairs of notes with high tag overlap (2+ shared tags), ranked by overlap count.

### Semantic review

For each pair (up to 10 highest-overlap pairs):
1. Read both notes
2. Extract key claims from each (Thesis, Evidence, Key Facts sections)
3. Check for:
   - **Direct contradictions** — Note A says X, Note B says not-X
   - **Temporal supersession** — Note A's claim is outdated by Note B's newer evidence
   - **Scope conflicts** — Both claim authority on the same topic but reach different conclusions

### Report

Present findings:
```
🔍 CONTRADICTION SCAN:
  Pairs checked: N
  Contradictions found: N
  Superseded claims: N

  ⚠️ CONTRADICTION:
    [[note-a]] claims: "X"
    [[note-b]] claims: "Y"
    Resolution: [suggest which is correct, or flag for the user]

  📅 SUPERSEDED:
    [[older-note]] (2026-01-15): "X was true"
    [[newer-note]] (2026-03-20): "X is no longer true because Y"
    Action: Update older note with correction
```

### Fix (with approval)

If the user approves resolutions:
- Update contradicted notes with correction callouts
- Update superseded notes with `> 📅 **Updated:** See [[newer-note]] for current information`
- Update `updated:` dates
- Regenerate MOCs

---

## graph [slug]

Navigate the Knowledge Archive as a graph.

**Done looks like:** graph stats shown (nodes, edges, clusters, hubs, isolates) with no argument, or a traversal from the given slug listing the notes connected within the requested hops.

**No argument — stats overview:**
```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeGraph.ts stats
```

**With slug — traverse from a note:**
```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeGraph.ts traverse <slug> --hops 2
```

Show all notes connected within 2 hops via tags, wikilinks, and typed relationships.

**Related notes only:**
```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeGraph.ts related <slug>
```

---

## retrieve <query>

Compressed context retrieval over the Knowledge Archive using BM25-lite scoring.

**Done looks like:** the top matching notes returned with compressed summaries (or raw excerpts under `--raw`), ranked, without reading full files.

```bash
bun ~/.claude/LIFEOS/TOOLS/MemoryRetriever.ts "<query>" --top 5
```

Returns the top matching notes with compressed summaries, ranked by title match, tag overlap, and content frequency.

For raw excerpts without LLM compression:
```bash
bun ~/.claude/LIFEOS/TOOLS/MemoryRetriever.ts "<query>" --raw
```

---

## mine

Mine recent conversations for memory candidates (decisions, preferences, milestones, problems).

**Done looks like:** candidates written to `KNOWLEDGE/_harvest-queue/` for review (never straight to KNOWLEDGE/), ready for `/knowledge harvest` to process.

```bash
bun ~/.claude/LIFEOS/TOOLS/SessionHarvester.ts --mine --recent 10
```

For dry run (preview only):
```bash
bun ~/.claude/LIFEOS/TOOLS/SessionHarvester.ts --mine --recent 10 --dry-run
```

---

## distill

Weekly harvest of the archive into routed outputs. **Distill is a router, not a destination**: every item lands in the system of record that already owns it, and the digest is an index pointing at those destinations. It never creates or edits KNOWLEDGE notes (mutations belong to `develop`/`contradictions`/`ingest`), and it never re-surfaces an item a previous run already routed.

**Done looks like:** a dated digest at `~/.claude/LIFEOS/MEMORY/DIGESTS/YYYY-MM-DD-distill.md` with ≤10 items across three lanes, every item citing its source notes and linking its routed destination; ≤5 content-idea issues filed; ≤5 upgrades filed; all surfaced items marked in state. Overflow is named with a dropped-count, never silently truncated.

### Step 1 — Gather (deterministic)

```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeDistill.ts gather --days 7
```

Returns JSON: in-window notes (created/updated, minus previously surfaced), hot tag clusters (window count vs archive baseline), seedling and contradiction stats.

### Step 2 — Synthesize (the model leg)

Cluster the candidates into digest items. Quality bar per item: ≥2 source notes, a why-now line (recency, cluster growth, or TELOS relevance), and a one-sentence pitch in plain language. Three lanes:

- **Content candidates** — ideas that could become a post, newsletter section, or video. Bias toward the principal's TELOS content goals.
- **System improvements** — anything that smells like a LifeOS upgrade.
- **Archive health** — contradiction pairs and seedling counts, report-only; deeper action routes to `/knowledge contradictions` or `/knowledge develop`.

### Step 3 — Route to systems of record

Content lane (≤5). The destination repo and label come from `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Cortex/DistillConfig.json` (`contentRepo`, `contentLabel`) — never hardcoded here:
```bash
gh issue create --repo <contentRepo> --label <contentLabel> \
  --title "<pitch>" --body "<why-now + source note paths + suggested format>"
```
No config file → skip the issue lane and list content candidates in the digest only.

System lane (≤5; dedupe is claim-hash based, duplicates exit 0 silently):
```bash
bun ~/.claude/LIFEOS/TOOLS/Upgrades.ts add --claim "<one sentence>" --source autonomous \
  --recommendation "<proposed encoding>" --target <hook|doctrine|rule|skill|settings|context> \
  --evidence "<source note path>"
```

### Step 4 — Digest + mark

Write the digest file (lanes as sections; every item: pitch, sources, destination link or "empty — <reason>"), then:

```bash
bun ~/.claude/LIFEOS/TOOLS/KnowledgeDistill.ts mark --digest <digest-path>
```

which records surfaced slugs and item hashes in `MEMORY/STATE/distill.json`.

### Headless / scheduled

`bun ~/.claude/LIFEOS/TOOLS/KnowledgeDistill.ts run --headless [--dry-run]` performs all four steps unattended (synthesis via `Inference.ts`, never a nested `claude` session). The weekly launchd job `com.lifeos.distill` (Sun 09:00) runs exactly this; it is a manual plist for now, since no installer ships yet (public issue #2248, @mj-deving). `--dry-run` prints the full routing plan and writes nothing.

---

## recall <query>

Find prior LifeOS work — sessions, ISAs, conversations — by topic, partial words, or date phrases like "yesterday" or "last week". A deterministic Bun CLI searches five sources in parallel (work registry, session names, work dir names, ISA bodies, conversation jsonl), scores by token-overlap × recency, applies date filters, and returns ranked results with snippets.

**Done looks like:** ranked prior-work results with snippets — presented as the pretty block standalone, or used silently to anchor a paired request. When the ask is about what happened ("we just worked on that", "what did we do with X", "remember when we fixed Y", "didn't we already fix this", "why did we change", "what happened with", "when did we work on"), the answer also reads the top 3-5 matches in full and states for each what was being done, what was decided and WHY, the outcome, and any open issues; reporting only what changed without why is a miss. When the question implies something is broken again, it says what might have regressed, and when the principal is frustrated it names that in one line and spends every other sentence on decisions, outcome and open issues.

```bash
bun run ~/.claude/skills/Cortex/Tools/ContextSearch.ts "$ARGUMENTS" --pretty --limit 10
```

Flag patterns: `--limit N` · `--since YYYY-MM-DD` · `--json | jq '.results[0]'`. Date phrases parse inline: `"yesterday markdown"` becomes a single-day since/until window plus token search for `markdown`.

**Sources beyond the CLI.** `ContextSearch.ts` covers the work registry, session names, work dirs, ISA bodies and conversations. Artifacts are fragmented, so a what-happened recall also checks, in parallel:

| Source | Command |
|---|---|
| Git history, when code changed | `git log --oneline --all --grep="<keyword>" \| head -10` and `git log --name-only --oneline \| grep -i "<keyword>"` |
| Learnings and patterns | `grep -rl "<keyword>" ~/.claude/LIFEOS/MEMORY/LEARNING/` |
| Agent output captures | `grep -rl "<keyword>" ~/.claude/LIFEOS/MEMORY/RESEARCH/` |
| Multi-session progress files | `grep -l "<keyword>" ~/.claude/LIFEOS/MEMORY/STATE/progress/*.json` |

Search variants of the topic (status line, statusline, status-line). Order matches most recent first, each with its date, type (session, ISA, learning, research, commit) and path. After the synthesis, offer a deep dive: named artifacts read in full, the transcript of a specific conversation, or the commits, and a learning entry when the issue keeps recurring.

**Usage modes:**

1. **Standalone** (`/cs <topic>` or an explicit recall ask) — present the pretty block, then: "Context loaded on [topic]. Most recent: [X]. What would you like to do?"
2. **Paired with a request** — run the search silently first, use top results to anchor the answer; Read a result's `path` when deeper detail helps. Don't dump the search block unless asked.

**Recall gotchas (ported from the retired ContextSearch skill):**

- Token-overlap scoring, not substring matching — queries hit sessions sharing ≥1 non-stopword token, so half-remembered phrasing works.
- `today`/`yesterday`/`last week`/`N days ago`/`YYYY-MM-DD` parse out as bounded date filters; remaining tokens still score content.
- JSONL date = first user-message timestamp, not file mtime (mtime drifts on re-read); session-names.json entries fall back to mtime.
- JSONL search is restricted to this install's own conversation directory by design.
- No persistent index — every query rescans (~1–2s total); an opt-in cached index is the v2 if scale demands.
- `MEMORY/STATE/progress/` holds only old files (checked 2026-10-10): the newest is dated 2026-06-21, so a hit there is history, not a live project. Weigh it below WORK/ and transcripts, and give its date when citing it.

---

## Gotchas

- **Six entity types.** People, Companies, Ideas, Research, Books and Blogs (`KnowledgeSchema.ts` CANONICAL_TYPES). If it doesn't fit one of these, it's not knowledge — it belongs in WORK/ or LEARNING/.
- **Topic = tag, not domain.** A security insight is an Idea with a `security` tag. Never create topic-based folders.
- **The lookup test.** "Would the user look this up by name?" — if not, it's not knowledge.
- **Schema enforcement.** Each entity type has required fields defined in `_schema.md`. Always read the schema before writing.
- **Algorithm LEARN phase writes directly.** The LEARN phase has the best context — it writes to KNOWLEDGE/ with proper schemas. Harvester reflections are disabled.
- **Never delete notes without asking.** Pruning is automatic (90-day seedling expiry via harvester). Manual deletion requires the user's approval.
- **Wikilinks use strict kebab-case.** `[[prompt-injection]]` not `[[Prompt Injection]]`.
- **All harvested notes start as seedlings.** Only `/knowledge develop` promotes them.
- **Temporal validity is optional.** Notes can have `valid_from`/`valid_until` frontmatter fields to track when facts were true. The contradiction detector uses these to skip non-overlapping time windows.

## Examples

**Example 1: Search the archive**
```
User: "what do we know about prompt injection?"
→ Routes to search — 3-pass (lexical + frontmatter + wikilink) over MEMORY/KNOWLEDGE/
→ Returns table of matching notes with domain, status, tags
```

**Example 2: Ingest a source**
```
User: "/knowledge ingest https://example.com/article"
→ Fetches the source, classifies entity type, creates primary note with typed related: links
→ Ripple pass proposes updates to existing related notes; user approves; MOCs regenerated
```

**Example 3: Status check**
```
User: "knowledge status"
→ Runs KnowledgeHarvester.ts status
→ Shows domain note counts, orphan wikilinks, stale seedlings, time since last harvest
```
