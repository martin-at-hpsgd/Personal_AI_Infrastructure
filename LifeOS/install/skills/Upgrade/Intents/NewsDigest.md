# NewsDigest

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples · References

A "what's new in AI" read in one place: a deduplicated multi-source digest, a single-source pull from smol.ai's AINews or Wes Roth's Natural 20, a CompetitorTracking report on OpenAI, Google, Microsoft, Meta, Mistral and xAI, or an Anthropic updates digest scored for LifeOS impact, each saved under `MEMORY/RESEARCH/` so trends read across runs. The Anthropic updates mode carries its AnthropicUpdates intent on top of this skill's own `Tools/Anthropic.ts` diff.

## Ideal State

- A bare "what's new in AI" or "latest AI news" returns one combined digest in the **Combined digest** format holding items from smol.ai, Wes Roth / Natural 20 and tldrsec; "check smol.ai", "Wes Roth news", "competitor tracking" or "Anthropic updates" returns that one report in its own format below.
- Within a digest the same story told by several sources is one item, conflicts between sources are reconciled, items are ranked by impact, and security items land in Security Insights.
- Every item carries its source, a link that resolves, and a one-line why-it-matters-to-LifeOS.
- The smol.ai and tldrsec items come from the raw page, body text extracted in a `.ts` file; the Wes Roth items come from the latest Natural 20 video transcripts or, failing that, web research, and the digest says which.
- A CompetitorTracking report gives each monitored vendor's material moves (announcements, launches, pricing, model releases), then a strategic read for the principal: how each move compares with the principal's current stack, opportunities, threats and recommendations, every claim citing a source.
- An Anthropic updates digest is built from this run's `Tools/Anthropic.ts` output and follows the **Anthropic updates** format: every API change, deprecation, model update or feature release in that diff that touches LifeOS appears with its source, link and LifeOS impact, the quietly announced ones included, and Action Items is empty only when nothing in the diff applies to LifeOS.
- The digest's Model Updates section reports Anthropic's model news from the diff; whether a LifeOS lane is behind is answered by quoting `ModelSync.ts --check`, which owns model-ID detection.
- Every source `Tools/Anthropic.ts` warned it could not fetch is listed as unverified, and a run with any such warning is never called up to date.
- When asked for the story explanation, the combined output adds a story explanation after the categorized sections, then source links organized by topic ending with the primary newsletter sources; "with links" puts the links inline after each sentence as `[LABEL](url)`. Its item count and the separator between several links come from the USER `PREFERENCES.md` § News digest (`story_items`, `link_separator`); without that file the default is 12 items with links separated by a comma.
- The report is saved to `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/` under the filename its format names (`~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_ai-news-combined.md`, `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_smol-ai-news.md`, `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_wes-roth-analysis.md`, `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_competitor-tracking.md`, `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_anthropic-updates.md`), and the AINews state files record the run (Tool contract), so the next run's window starts where this one ended.
- A source that failed to fetch is listed as unverified in the report, never silently dropped and never reported as "nothing new".

## Anti-criteria

- No cited item that cannot be found at its source, no stated date or claim that is wrong, and no story that appears twice in one digest.
- A WebFetch result is a small model's summary and is never cited as having read the page.
- Source content is never copied: summaries are for trend analysis.
- No speculation dressed as fact in a CompetitorTracking report.
- No section padded with filler: a section with nothing real in it is omitted.
- No state-file write that drops another source's entry or rewrites earlier run-history lines.
- No second Anthropic fetcher: the Anthropic updates mode reads `Tools/Anthropic.ts` and nothing that re-fetches its sources, and it does no model-ID detection of its own.

## Inputs

| Source | Where | Register |
|---|---|---|
| **smol.ai** (AINews, the Latent Space daily) | `https://news.smol.ai/` | Concise, tactical: AI industry news, quick updates |
| **Wes Roth / Natural 20** | YouTube channel `https://www.youtube.com/@WesRoth/videos` | Deep technical analysis, video-based, long-form |
| **tldrsec** | `https://tldrsec.com/` (the SecurityUpdates skill owns its own digest) | Security news, vulnerabilities, threat intelligence |
| **Anthropic** (Anthropic updates mode only) | the blogs, feeds, indexes, changelogs, docs pages and GitHub repos in `skills/Upgrade/sources.json`, read through `Tools/Anthropic.ts` | API changes, deprecations, model and feature releases |

CompetitorTracking monitors, primary: **OpenAI** (GPT models, ChatGPT, API changes), **Google** (Gemini, Vertex AI), **Microsoft** (Azure OpenAI, Copilot); secondary: **Meta** (Llama models, open source AI), **Mistral** (open-weights models), **xAI** (Grok).

The window is the time since `last_check_timestamp` in the state file, 7 days when the file is absent, or the period the principal names. The Anthropic updates mode uses `Tools/Anthropic.ts`'s own window instead: everything new since its `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/last-check.json`, with a lookback of 30 days or the number of days passed to it.

## Tool contract

Run from `~/.claude`.

```bash
curl -sL <url>                             # any raw source page; then extract the body text in a .ts file
curl -sL https://news.smol.ai/            # smol.ai AINews
curl -sL https://tldrsec.com/              # latest issue; same extraction
yt-dlp --flat-playlist --dump-json 'https://www.youtube.com/@WesRoth/videos'   # latest Natural 20 videos
bun ~/.claude/LIFEOS/TOOLS/GetTranscript.ts '<video url>'                       # transcript; fallback: fabric -y '<video url>'
```

Anthropic updates mode, the only fetch it makes:

```bash
bun skills/Upgrade/Tools/Anthropic.ts [days] [--force] 2>&1   # diff vs USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/last-check.json; prints the report, then saves state itself
bun LIFEOS/TOOLS/ModelSync.ts --check                           # read-only: is any Claude lane behind the published lineup
```

`2>&1` is required: a source that fails to fetch is reported only as a `⚠️ Failed to fetch <name>` or `⚠️ Error fetching <kind> <name>` line on stderr, and each such line is one unverified source. `Tools/Anthropic.ts` keeps its own state (`USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/last-check.json`) and run log (`LIFEOS/MEMORY/STATE/Upgrade/run-history.jsonl`); this mode writes neither of the AINews state files below.

X links inside a source go through the X skill; without it, the Apify tweet scraper. CompetitorTracking runs through `Skill("Research")` for announcements, launches, pricing and model releases inside the window.

State files (kept from AINews; merge, never drop keys):

| File | Shape | Write after each run |
|---|---|---|
| `LIFEOS/MEMORY/STATE/AINews-last-check.json` | `{"last_check_timestamp": ISO, "sources": {"<key>": {"last_hash", "last_title", "last_checked"}}}` | set `last_check_timestamp`; upsert `digest_smol_ai`, `digest_wes_roth`, `digest_tldrsec`, `digest_competitors` with the newest item title and `last_checked`; leave the `changelog_*` / `docs_*` keys untouched |
| `LIFEOS/MEMORY/STATE/AINews-run-history.jsonl` | one JSON line per run: `{"timestamp","days_checked","forced","updates_found","high_priority","medium_priority","low_priority"}` | append one line, adding `"intent":"NewsDigest","mode":"combined\|smol\|wesroth\|competitors"` |

`--force` from the principal ("everything, ignore last check") ignores the window and records `"forced": true`.

## Gotchas

- **smol.ai, Wes Roth and tldrsec are defaults; swap in the sources you follow** (carried from AINews). Their output is for trend analysis, never content copying.
- **The AINews state files predate this intent** (AINews retired 2026-10-10, files last written 2026-10-09 by the retired `CheckAnthropicChanges.ts`). Their `changelog_*` and `docs_*` keys belong to Anthropic page tracking, which `Tools/Anthropic.ts` now does; never delete them.
- **`Tools/Anthropic.ts` exits 0 when sources fail** (read 2026-10-10). Each fetcher catches its error, warns on stderr and returns nothing, and with zero updates the tool prints "Everything is up to date!". The retired `CheckAnthropicChanges.ts` exited 1 on any failed fetch, which is what the old AnthropicUpdates intent keyed on. Until the tool counts failures, the stderr warnings are the only signal.
- **A failed GitHub page is silent.** `pageUntil` returns nothing for a non-OK GitHub response (rate limit included, likeliest when `GITHUB_TOKEN` is unset) and prints no warning, so a run with no GitHub items states the GitHub lane as unconfirmed, never as "no changes".
- **The Anthropic diff is shared with the Upgrade sweep.** Both read and advance `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/last-check.json`, so an item one run reported does not come back in the other. `--force` re-shows current content without the window.
- **Before 2026-10-10 there was no cross-run seen ledger** for these sources, so an item could reappear across runs; the window from `last_check_timestamp` is what now stops that.

## Output format

**Combined digest** — saved as `YYYY-MM-DD_ai-news-combined.md`

```markdown
# AI NEWS DIGEST

**Date:** [Date]
**Sources:** smol.ai, Wes Roth, tldrsec

---

## Major Takeaways
## Trends
## Model Releases
## Partnerships
## Tools
## Security Insights
## Innovative Ideas

---

**Saved to:** `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_ai-news-combined.md`
```

With the story explanation: after Innovative Ideas, `### STORY EXPLANATION (<story_items> ITEMS)` (the count from § Inputs: USER `PREFERENCES.md` `story_items`, default 12) then `### SOURCE LINKS` (by topic, primary newsletter sources last).

**smol.ai** — `# SMOL.AI NEWS UPDATE` (Date, Source: smol.ai), sections `## Breaking News`, `## Model Releases`, `## Industry Moves`, `## Product Launches`; saved as `YYYY-MM-DD_smol-ai-news.md`.

**Wes Roth** — `# WES ROTH ANALYSIS` (Date, Source: Natural 20 / Wes Roth), sections `## Technical Deep Dives`, `## Industry Analysis`, `## Model Comparisons`, `## Future Predictions`; saved as `YYYY-MM-DD_wes-roth-analysis.md`.

**CompetitorTracking** — saved as `YYYY-MM-DD_competitor-tracking.md`

```markdown
# AI VENDOR TRACKING REPORT

**Date:** [Date]
**Period:** [Time period analyzed]

---

## OpenAI
## Google
## Microsoft
## Other Players
[Meta, Mistral, xAI, others]

## Strategic Analysis

### Opportunities
[Where the principal's current stack has an advantage]

### Threats
[Where other vendors are advancing]

### Recommendations
[Strategic suggestions for the principal]
```

**Anthropic updates** — saved as `YYYY-MM-DD_anthropic-updates.md`

```markdown
# ANTHROPIC UPDATES

**Date:** [Date]
**Sources Checked:** [the sources.json lanes this run reached]

---

## API Changes
[New endpoints, parameter changes, deprecations]

## Model Updates
[New Claude versions, capability improvements; `ModelSync.ts --check` verdict on our lanes]

## Feature Releases
[Platform features, Console updates]

## LifeOS Impact Assessment
[Specific recommendations for LifeOS infrastructure]

### Action Items
- [ ] [Required updates or investigations]

---

**Saved to:** `~/.claude/LIFEOS/MEMORY/RESEARCH/YYYY-MM/YYYY-MM-DD_anthropic-updates.md`
```

API Changes and Feature Releases are omitted when the diff holds nothing for them. Model Updates always appears because it carries the `ModelSync.ts --check` verdict, and LifeOS Impact Assessment and Action Items always appear, reading "none" when nothing applies.

Every report ends with the unverified-source list (empty when every fetch succeeded) and the `Saved to:` path.

## Examples

```
User: "what's new in AI?"
→ Combined digest from smol.ai, Natural 20 and tldrsec since the last check
→ Saved to MEMORY/RESEARCH/2026-10/2026-10-10_ai-news-combined.md; state files updated
```

```
User: "Anthropic updates, anything we need to act on?"
→ ANTHROPIC UPDATES from this run's Tools/Anthropic.ts diff, each change scored for LifeOS impact, Action Items filled
→ Every source that warned on fetch listed as unverified; saved to MEMORY/RESEARCH/2026-10/2026-10-10_anthropic-updates.md
```

```
User: "competitor tracking for the last month"
→ AI VENDOR TRACKING REPORT, Period: last 30 days, each claim cited, Strategic Analysis at the end
```

## References

- `SKILL.md` § Sources & Tools — `GetTranscript.ts`, `yt-dlp`, and the Anthropic changelog lane (`Tools/Anthropic.ts`) that the Anthropic updates mode reads.
- `Intents/Models.md` and `LIFEOS/TOOLS/ModelSync.ts` — model-ID detection and lane moves, which this intent only quotes.
- `skills/SecurityUpdates/SKILL.md` — the full tldrsec digest when security, not AI news, is the ask.
