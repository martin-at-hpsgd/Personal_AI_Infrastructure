# PullBookmarks

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Safety gates · Tool contract · Gotchas

The bookmark sweep: new X bookmarks fetched, previously-seen ones filtered out, each new one given an idea-issue or skip disposition in the install's work repo, and LifeOS Upgrade analysis run on the new findings into one report.

## Ideal State

- Every bookmark analyzed carries its full text and fields from the `--json` fetch of 50 bookmarks (last 30 in quick mode).
- New bookmarks are exactly the fetched ones whose `id` is not in `seenIds`; a missing, empty or malformed state file is treated as a first run (no seen IDs, no last pull).
- The run reports Fetched, Previously seen and New counts; with zero new bookmarks it reports "No new bookmarks since last pull on [lastPull date]" and updates only the `lastPull` timestamp.
- Every new bookmark is classified HIGH, MEDIUM or LOW by the relevance profile in `PREFERENCES.md` (§ Inputs): HIGH gets deep analysis and LifeOS Upgrade extraction, MEDIUM a note for awareness with brief analysis (skipped in quick mode), LOW is skipped.
- Every new bookmark ends with exactly one disposition, recorded inline while it is classified, never as a trailing batch step or an afterthought, so none is dropped on a long run: `create` (it is an actionable idea under the idea definition in `PREFERENCES.md`, filed via `bookmark-issue.ts create`) or `skip` (it isn't, with a reason).
- The final `bookmark-issue.ts audit` over ALL new bookmark ids this run passed before the run finished; the audit gate fails loudly (exits nonzero, lists the ids) if any new bookmark has neither disposition.
- A prior-work index, a concise list of topics LifeOS has already implemented or actively worked on, existed before any bookmark was analyzed. It draws on the capability map, `LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md` (subsystem list) and `LIFEOS/USER/PROJECTS.md` (project list), plus a Cortex recall of the last 60 days of sessions and ISAs on keywords from the HIGH bookmark topics.
- The index is aggressive about marking things ALREADY BUILT: a bookmark recommending something that maps to an existing subsystem (memory system, security pipeline, delegation system, skill system, hook system, agent system, Workflows, Feed, etc.) is ALREADY BUILT, so nothing already implemented is recommended.
- Every recommendation, without exception, is tagged with its correct prior-work status (NEW, ALREADY BUILT, IN PROGRESS or EXTENDS) from that index.
- Each HIGH-relevance bookmark has its own analysis in the per-bookmark JSON shape, produced by a parallel agent, that covers the external URLs in the tweet (articles, repos, blog posts) and extracts techniques under the Upgrade extraction rules, quoting the actual content with no vague summaries and mapping each to a specific LifeOS component.
- The report uses the Upgrade output format with the disposition table (idea-issues created with URLs, skipped, audit result) at the top.
- After successful processing the state file holds the current `lastPull`, all previously seen plus newly processed IDs in `seenIds`, and `pullCount` incremented by one, with the oldest 500 `seenIds` trimmed when over 1000 entries (they're old enough to never reappear in bookmarks).

## Anti-criteria

- New bookmarks are never filtered by tweet `created_at`. The tweet's `created_at` is its *publication* time, not when the principal *bookmarked* it — a month-old tweet bookmarked today is a brand-new bookmark. `seenIds` is the only correct dedup for "new bookmark." Filtering by `created_at` would silently drop newly-saved older tweets before they reach capture/audit. (Audit finding, 2026-06-11.)
- No new bookmark is left without a disposition, and when it is uncertain whether one is an idea it is created: a stray issue is one click to close, but a skipped idea is lost forever once its id enters `seenIds` and is never re-analyzed (2026-06-11).
- Nothing tagged ALREADY BUILT or IN PROGRESS appears in Recommendations; it is mentioned only in Discoveries as external validation.
- Issue capture never replaces the Upgrade report; it is additive.
- Issue provenance never comes from the human fetch output, which truncates text to 80 chars.

## Output format

**Output count:**
```
Fetched: N total bookmarks
Previously seen: N skipped
New bookmarks: N to analyze
```

**Report** a disposition table at the top of the report — `Idea-issues created: N` (with URLs), `Skipped: M`, and the audit result (`all disposed` or the failing ids). Already-issued bookmarks report their existing URL — note as "already captured," not new.

**Return format per bookmark:**
```json
{
  "tweet_id": "12345",
  "tweet_url": "https://x.com/user/status/12345",
  "author": "@username",
  "text": "full tweet text",
  "external_links": ["https://..."],
  "relevance": "HIGH",
  "techniques": [
    {
      "name": "Technique name",
      "source": "Twitter: @username — tweet text snippet",
      "exact_content": "Quoted code/config/approach from linked content",
      "lifeos_component": "Which LifeOS file/skill/hook this improves",
      "implementation": "What to change in LifeOS",
      "priority": "CRITICAL|HIGH|MEDIUM|LOW"
    }
  ]
}
```

Tags:
- **NEW** — No prior work found. Genuinely novel for LifeOS.
- **ALREADY BUILT** — LifeOS already has this. Skip from recommendations entirely. Note in Discoveries as validation.
- **IN PROGRESS** — Active or recent session found. Skip from recommendations, note status.
- **EXTENDS** — LifeOS has the base capability but this bookmark suggests a specific enhancement. Include in recommendations with context on what exists vs what's new.

```markdown
# X Bookmarks Upgrade Report
**Generated:** [timestamp]
**Bookmarks Fetched:** [N] total | [N] new | [N] skipped (seen)
**Idea-issues created:** [N] new issues | [N] already captured (with URLs)
**Analysis:** [N] HIGH relevance | [N] MEDIUM | [N] LOW (skipped)
**Prior Work Check:** [N] already built | [N] in progress | [N] new

---

## Discoveries

| # | Discovery | Source | Status | Why Interesting |
|---|-----------|--------|--------|-----------------|
| 1 | [name] | @user | NEW/ALREADY BUILT/EXTENDS | [why — if ALREADY BUILT, note what LifeOS has] |

## Recommendations (NEW and EXTENDS only)

### CRITICAL — Integrate immediately
| # | Recommendation | Tag | What Exists | What's New | Effort |
|---|---------------|-----|-------------|------------|--------|

### HIGH — Integrate this week
...

### MEDIUM — When convenient
...

## Technique Details
[Full extraction per Upgrade format — NEW and EXTENDS items only]
```

## Inputs

The state file, `~/.claude/LIFEOS/MEMORY/STATE/X/bookmarks-state.json`, carries:

- `lastPull` — ISO timestamp of last successful pull
- `seenIds` — Array of tweet IDs already processed
- `pullCount` — Running count of pulls

The install's sweep settings live in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/X/`:

- `PREFERENCES.md` § Relevance profile — the HIGH, MEDIUM and LOW criteria for this install. Without it, HIGH is anything that could improve the AI harness LifeOS runs on (agents, skills, hooks, prompting, evals, MCP, context handling), MEDIUM is general AI and software-architecture news, and LOW is everything else plus the principal's own posts.
- `PREFERENCES.md` § What counts as an idea — the definition used for the create-or-skip call, and the `--property` values that map an idea to one of the principal's properties. Without it, an idea is anything the principal could act on, and `--property` is omitted.
- `Config.md` `bookmark_sweep` — the labels every idea-issue carries and the property label prefix (`Setup.md` § Fill in). The repo idea-issues are filed in is `bookmark_sweep.repo` there (default: the repo in `LIFEOS/USER/WORK/work_repo.json`), and the agent label is `WORK.AGENT_LABEL` from `LIFEOS/USER/WORK/config.yaml`.

If the principal says "quick bookmark check" or "just check bookmarks":
- Fetch only last 30 bookmarks
- Skip MEDIUM relevance items
- Abbreviated report (Discoveries + Recommendations only, no Technique Details)

## Safety gates

For each NEW bookmark, decide whether it is an actionable idea under `PREFERENCES.md` § What counts as an idea. When uncertain, create (§ Anti-criteria has the reason).

**Final gate.** After processing all new bookmarks, run the audit over every new bookmark id; finishing without it is how an undisposed idea gets lost. It exits nonzero and lists any bookmark you forgot to dispose — if it fails, go back and create-or-skip those before finishing:

```bash
bun ~/.claude/skills/X/Tools/bookmark-issue.ts audit --ids "<comma-separated list of ALL new bookmark ids this run>"
```

## Tool contract

**A run is a Workflow at the tier its parts set** (Router ISA F8, Algorithm § Routing; OPERATIONAL_PREFERENCES § Workflows is the opt-in): the parts this intent runs at the same time become lanes of a script written for that run, the dependent steps stay in order, and the main session stays the only writer of the deliverable.

**Pipeline:**
```
Tools/bookmarks.ts (fetch) → State filter (skip seen) → [Capture actionable ideas as issues] → Upgrade analysis → State update
```

```bash
bun run ~/.claude/skills/X/Tools/bookmarks.ts fetch 50 --json
```

Use `--json` so you get each bookmark's FULL text and fields (the human output truncates text to 80 chars, which would weaken issue provenance). Parse the JSON array; each object has `id`, `text` (full), `author`, `author_name`, `created_at`, `url`, `urls`.

**Create** (it's an idea) — draft a one-line title and a 1–3 sentence body in the principal's voice:

```bash
bun ~/.claude/skills/X/Tools/bookmark-issue.ts create \
  --id "<tweet_id>" \
  --title "<short idea title>" \
  --body "<1-3 sentence idea — what it is and why it's worth doing>" \
  --url "<tweet_url>" --author "<@author>" --text "<original tweet text>" \
  [--property <a value from PREFERENCES.md>]
```

Set `--property` only when the idea clearly maps to one; omit otherwise and let triage assign. The tool self-dedups by bookmark id (safe on re-runs), refuses when a configured label is missing from the repo (exit 3), and tags the issue with the `bookmark_sweep.labels` from `Config.md` plus the WORK.AGENT_LABEL.

**Skip** (genuinely not an idea — pure-interest reading, news with no action, humor, personal, the principal's own tweets):

```bash
bun ~/.claude/skills/X/Tools/bookmark-issue.ts skip --id "<tweet_id>" --reason "<why — e.g. humor, no action>"
```

**Prior-work recall** for the index: `Skill("Cortex", "recall <keywords from HIGH bookmark topics>")` over the last 60 days.

**Per-HIGH-bookmark agent sources.** Tweet content comes from `bun ~/.claude/skills/X/Tools/read.ts <tweet id or URL>`, which uses the official X API with the principal’s own credentials, or from the principal’s own exported data. When the API refuses a tweet (deleted, protected, rate-limited, or the plan does not cover it), that bookmark is recorded as unreadable with the reason and the sweep stops trying other routes for it; no scraping service is used. Never WebFetch an X URL. External links (articles, repos, blog posts) are read as raw page text (`fetch` or `curl`, body extracted in a `.ts` file) with an honest user agent, within the site’s terms; when a site blocks automated access, the bookmark is marked unreadable and the block is reported. Never WebFetch, which returns a small model’s summary and cannot supply the quoted `exact_content`.

Write updated state to `~/.claude/LIFEOS/MEMORY/STATE/X/bookmarks-state.json` after successful processing:

```json
{
  "lastPull": "[current ISO timestamp]",
  "seenIds": ["[all previously seen + newly processed IDs]"],
  "pullCount": [previous + 1]
}
```

Per-id dispositions live in `~/.claude/LIFEOS/MEMORY/STATE/X/bookmark-issues.json`, written only by `bookmark-issue.ts`.

## Gotchas

- **Token expiry** — Access tokens last ~2 hours. When `Config.md` names `token_store: cloudflare-kv`, an external process owns the refresh chain; an expired token means that process is down, so fix it rather than refreshing locally. If the grant itself is revoked, re-authorize: `bun run ~/.claude/skills/X/Tools/bookmarks.ts authorize`
- **API rate limit** — 180 requests per 15-min window for bookmarks endpoint
- **Max 100 per request** — Use pagination (next_token) for larger pulls
