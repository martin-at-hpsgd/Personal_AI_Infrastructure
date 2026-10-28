---
name: Upgrade
evals:
  deterministic:
    - command: "bun LIFEOS/TOOLS/UpdateModels.ts --check"
      falsifier: "exits nonzero when a Claude id is pinned outside the registry, agent frontmatter skips tier aliases, or a non-Claude versioned id outside CROSS_VENDOR sits in executable code"
  manual:
    reason: "recommendations require review that their cited technique is new, applicable, and not already adopted or rejected"
    falsifier: "the reviewer finds a recommendation lacks a supporting source, duplicates current state, or cannot map to a concrete improvement"
metadata:
  short-description: "Find actionable LifeOS improvements from harness releases, practitioner techniques, and internal reflections; filter already-adopted or rejected ideas."
version: 1.4.3
description: "Improve LifeOS from what the best practitioners are shipping around AI harnesses — Anthropic first (changelogs, docs, releases), then trusted creators, trending repos, and the system's own reflections — extracting concrete techniques and filtering them against verified current state so nothing already-done or rejected is re-recommended; also digests AI industry news and tracks AI competitors. USE WHEN upgrade, system upgrade, check Anthropic, new Claude features, algorithm upgrade, LifeOS upgrade, mine reflections, upgrade models, update models, latest models, are we on the latest models, model freshness, AI news, what's new in AI, AI industry news, smol.ai, AINews, Wes Roth, competitor tracking, what are OpenAI and Google doing. NOT FOR mining one piece of content (Harvest), releases or repo ops, or security news (SecurityUpdates)."
---

# Upgrade

**Contents:** Ideal State · Intent Routing · Sources & Tools · Data & Config · Gotchas · Examples

Improves LifeOS from what the best practitioners are shipping around AI harnesses, Anthropic most importantly, and from the system's own reflections, as tiered, evidence-backed recommendations, and keeps every model LifeOS uses on its vendor's latest release. It also answers "what's new in AI" with a sourced news digest, a competitor report and an Anthropic updates digest scored for LifeOS impact (`Intents/NewsDigest.md`, which absorbed the retired AINews skill).

Signal comes from two directions, and a good run uses both: **external** (what Anthropic and the best practitioners are shipping) and **internal** (what the system's own reflections and failure history say is weak). The most valuable recommendations are usually where the two agree.

## Ideal State

- Every recommendation shows the technique itself (quoted or code-blocked from its source), names the exact LifeOS file or component it improves, and carries a Prior Status backed by file:line evidence gathered in this run.
- Nothing already implemented, deferred by decision, or rejected is recommended again: implemented items appear under Skipped Content with their evidence, and an idea rejected in `MEMORY/KNOWLEDGE/REJECTED/` or the Upgrades store returns only with a named reason the context changed.
- No absence is reported that was not positively probed this run, and no adoption is recommended without a backward-compatibility check against current skills, hooks and workflows.
- A sweep report follows `References/OutputFormat.md` and arrives on its deadline, listing every source processed, skipped (with the reason) or timed out, so a missing lane lowers coverage without delaying or hiding it.
- A "what's new in AI" request returns one deduplicated, sourced digest saved under `MEMORY/RESEARCH/`, with any failed source named as unverified (`Intents/NewsDigest.md`).
- After a model run, no lane sits behind its vendor's latest same-class release unless the report lists it as a decision with its exact one-line fix.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **Upgrade** | "check for upgrades", "check sources", "any updates", "check Anthropic", "check YouTube", "upgrade" | `Intents/Upgrade.md` |
| **MineReflections** | "mine reflections", "check reflections", "what have we learned", "internal improvements", "reflection insights" | `Intents/MineReflections.md` |
| **AlgorithmUpgrade** | "algorithm upgrade", "upgrade algorithm", "algorithm upgrade proposals" | `Intents/AlgorithmUpgrade.md` |
| **ResearchUpgrade** | "research this upgrade", "deep dive on [feature]", "further research", "dig deeper" | `Intents/ResearchUpgrade.md` |
| **Models** | "upgrade models", "update models", "model upgrade", "latest models", "are we on the latest models", "model freshness" | `Intents/Models.md` |
| **FindSources** | "find upgrade sources", "find new sources", "discover channels", "expand monitoring" | `Intents/FindSources.md` |
| **NewsDigest** | "what's new in AI", "AI news", "latest AI news", "smol.ai", "Wes Roth", "competitor tracking", "Anthropic updates", "Anthropic updates digest", "what changed at Anthropic and what do we need to do" | `Intents/NewsDigest.md` |

**Default intent:** a bare "upgrade" or "check for upgrades" runs **Upgrade** (which includes reflection mining). "Check Anthropic" is the Upgrade sweep's tiered recommendations; "Anthropic updates" is NewsDigest's ANTHROPIC UPDATES digest. Both read the same `Tools/Anthropic.ts` diff.

| File | Read when |
|------|-----------|
| `References/OutputFormat.md` | writing any report: section order, Prior Status legend, table columns, hard rules |
| `References/ExampleReport.md` | checking a finished report against a worked example of the format |
| `Setup.md` | first-time setup: optional GITHUB_TOKEN, YouTube channels, user sources and the programs those lanes call |

## Sources & Tools

| Surface | Contract |
|---------|----------|
| Anthropic (30+ sources: blog, changelogs, GitHub repos, docs) | `bun Tools/Anthropic.ts` — diffs against `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/last-check.json`, updates it itself |
| YouTube channels | Config: `youtube-channels.json` in CUSTOMIZATIONS (optional; create it as `{"channels": []}` if absent). List: `yt-dlp --flat-playlist --dump-json 'https://www.youtube.com/@HANDLE/videos'`. Transcript: `bun ~/.claude/LIFEOS/TOOLS/GetTranscript.ts '<url>'`. Seen-state: `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/youtube-videos.json` — update after processing |
| GitHub trending | Config: `github_trending` block in user `user-sources.json` in CUSTOMIZATIONS (optional; absent = lane skipped, noted in Sources Processed). Shape: `{"github_trending":{"enabled":true,"lookback_days":7,"min_stars":50,"results_per_query":3,"queries":["…"]}}`. `gh api 'search/repositories?q=QUERY+created:>DATE+stars:>N&sort=...&per_page=3'`. Seen-state: `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/github-trending.json` — merge, never drop entries |
| Custom sources | `user-sources.json` in CUSTOMIZATIONS (optional): `"blogs":[{"name","url","priority","type"}]` — fetch each; skip dead/redirected pages with a note. Absent = lane skipped, noted in Sources Processed |
| Your own GitHub repos | `github_repos` in `user-sources.json` (optional): `[{"name","repo":"owner/name","priority","check_releases","check_commits"}]`, appended by `Tools/Anthropic.ts` to the shipped list (repos you maintain or track upstream, such as the LifeOS upstream). A malformed file or key stops the run with the file and key named |
| Claude Code internals | When discoveries touch hooks, settings, slash commands, MCP, agent types, or the SDK/API, spawn `Agent(subagent_type="claude-code-guide")` to verify against the live surface — never answer from memory |
| Internal reflections | `MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl` — method in `Intents/MineReflections.md` |
| Security findings (open scanner failures) | the command named by `securityFindingsCommand` in `user-sources.json` in CUSTOMIZATIONS (optional; emits JSON) — the running log of infra-security work the hourly scanner has found and not yet seen fixed, grouped by fix class with the command that clears each class. Absent on installs without the scanner: note it in Sources Processed and move on |

**Source labels in output:** `GitHub: claude-code vX.Y.Z` · `YouTube: Creator @ MM:SS` · `Docs: Section` · `Blog: Title`.

**Model moves: same class auto, cross class propose (principal directive, 2026-09-03).** Shared by the Upgrade and Models intents. `UpdateModels.ts --cross-vendor --sync` writes a lane when the newer roster id is the same family at equal-or-higher stability (GA→GA, preview→GA) and a live probe with our key succeeds; `ModelSync --daily` runs the same command every day, so an Upgrade run is not the only path. What remains after `--sync` — a cross-class `🆕` (flash→pro), a GA→preview, a `❌ MISSING`, or a `⛔` probe failure — is a decision with the exact one-line fix (`edit CROSS_VENDOR in models.ts`, or `UpdateModels.ts --apply <tier> <id>` for a Claude tier).

## Data & Config

First-time setup (accounts, keys, files to fill in): [Setup.md](Setup.md).

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Upgrade/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md (§ News digest sets the story-explanation format), configurations, resources, `youtube-channels.json` and `user-sources.json` override the defaults here; when it is absent, the defaults stand. Monitoring state is install data and lives there too, under `State/` (`last-check.json`, written by `Tools/Anthropic.ts`; `youtube-videos.json` and `github-trending.json`, the seen-lists, created on the first run that needs them). An optional `History.md` there holds the install's provenance behind generic gotchas and comments, read on demand.

## Gotchas

- **A reported absence is probed, never inferred (2026-08-06).** Internal synthesis is held to the same standard as external findings: before an absence-claim earns a 🆕/CRITICAL tag, the thing claimed missing is grepped or read for in this run. A reported absence you did not check is a fabricated finding — the 2026-08-06 scan shipped a false CRITICAL across seven skills by grepping `context: fork` while never grepping `background:`.
- **Hard deadline, fail-open — never block on a straggler.** The deadline (~4 min per stage, enforced by `workflows/UpgradeFanout.js`; see the Upgrade intent's Tool contract) is set at dispatch; report with whatever is back when it hits. A missing source is listed as `⏳ timed out` in Sources Processed; it degrades coverage, never delays the report. (2026-07-18: one hung GitHub-trending agent stalled a run ~1 hour.)
- **Right-size the fan-out (~8 agents).** Small-file reads collapse into one agent; network sources get short budgets and are first to drop. Over-fan-out is the failure the reflection corpus flags most.
- **Budget the `claude-code-guide` freshness spawn per-spawn — it dies on a broad ask.** One spawn asked to cover the whole Claude Code surface (hook events, `settings.json`, slash commands, SKILL/subagent frontmatter, MCP, SDK, API) fans out a batch of doc lookups on its first turn, the results blow its context window, and it surfaces as `Prompt is too long` ~10s after spawn. Prompt length is not the cause; how much the ask makes it fetch is. Cap at ~3 areas per spawn, tell it to look things up rather than pull whole pages, and split the surface across parallel spawns so losing one costs a slice. Tell: sibling agents in the same batch succeed while this one dies. Fallback with no agent: read `Claude Code CHANGELOG` from `sources.json` directly and diff the version range. *(From a community pull request on the public LifeOS repo; reference in the USER extension's `History.md`.)*
- **GitHub search 422s on bare OR between qualifiers** with no free-text term. Give every query a free-text term; don't retry a 422 inside the budget.
- **Absence from `settings.json` ≠ a dead hook.** It's generated by MergeSettings; hooks also fire via dispatchers (PreToolGuard) and Pulse HTTP. Flag "verify before concluding dark," never assert dead from absence.

## Examples

```
User: "upgrade models — new Gemini model just came out; update Gemini, add a new model + agent, add to router"
→ Models intent
→ The Gemini lanes are on the new release after a live probe; the new model has a models.ts lane, an agent named for it and a Router lane; Router.ts status passes
```

```
User: "community scan: what have the best practitioners shipped recently? File the new techniques into the Upgrades queue"
→ Upgrade intent
→ A report in the canonical format, every 🔴/🟠/🟡 recommendation written to the Upgrades store, already-done items under Skipped Content with evidence
```

```
User: "check Anthropic only"
→ Upgrade intent, single source
→ An abbreviated report from that one source, every recommendation still carrying Prior Status with evidence
```
