---
metadata:
  short-description: "Collects security news, research, and breach reports from six sources into a ranked, deduplicated digest that skips items already seen."
name: SecurityUpdates
evals:
  manual:
    reason: "ranking and cross-source story merging depend on current external reporting and editorial judgment"
    falsifier: "a cited item is unavailable or materially misstated, the same story from two sources appears twice, or the ranking ignores a documented higher-impact item"
version: 1.0.12
description: "Aggregates and curates security news from six authoritative sources into a ranked, deduplicated digest across Security News, Research, and Ideas, with stateful tracking to avoid re-surfacing seen items. USE WHEN security news, security updates, breaches, sec updates, tldrsec, Krebs, Schneier, weekly security digest, CISO strategy. NOT FOR stack-specific CVE prioritization against your own tech stack (use your own vulnerability-management tooling), or AI industry news (Upgrade NewsDigest)."
---

# SecurityUpdates

Aggregates security news from six authoritative sources (§ Sources) into a ranked, deduplicated digest of up to 32 items across three categories: Security News, Security Research, and Security Ideas. A per-item record of what each run showed, kept in last-check.json by `Tools/Digest.ts`, avoids re-surfacing seen items, so a weekly run shows only what is new instead of the overlapping stories six sites publish on their own cadences.

## Ideal State

- A run returns at most 32 items, deduplicated across sources, ranked within News, Research and Ideas, each attributed to its source, and none fabricated.
- Nothing surfaced on an earlier run surfaces again, dated or not: every shown item's key is recorded in `MEMORY/STATE/SecurityUpdates-last-check.json` after each successful run, and the next run's candidates are filtered against it by `Tools/Digest.ts` (`Intents/Update.md` § Tool contract).
- Items come only from the configured sources: the six defaults in `sources.json`, swapped or extended through PREFERENCES.md.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Update** | "security updates", "sec updates", "/secupdates", "what's new in security" | `Intents/Update.md` |

**Default:** Run the Update intent.

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup: the smallest working PREFERENCES.md, accounts (none) and the proof command |
| `Tools/Digest.help.md` | the state filter, recorder and digest check the Update intent runs |

## Data & Config

User customizations, read before each run:
`<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/SecurityUpdates/PREFERENCES.md`
configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.

If the file exists, apply it: it can add sources and say which topics to emphasise or drop, and it overrides default behavior (the 32-item cap and the three categories stay). If it does not exist, proceed with the six default sources; nothing here is required. Setup, a smallest working PREFERENCES.md and the proof command are in [Setup.md](Setup.md). Run state is not config: it is written to `MEMORY/STATE/SecurityUpdates-last-check.json` (shape in `Intents/Update.md` § Tool contract).

## Sources

`sources.json` in the skill root is the one list of the six default sources: id, name, URL, type, and the categories each one feeds.

**Custom sources:** list them under "Extra sources" in `PREFERENCES.md` (see Data & Config); `sources.json` in the skill root holds the six defaults and is overwritten by updates, so do not edit it.

## Gotchas

- Not for stack-specific CVE tracking: use your own vulnerability-management tooling for that (a private overlay skill routes those requests on its own triggers). SecurityUpdates is for industry-wide security news.
- Research publications vs news: Distinguish between new research papers and news reporting. Cite appropriately.

## Examples

**"What's new in security?"** → Update intent → a ranked ≤32-item digest of what is new across all six sources since `~/.claude/LIFEOS/MEMORY/STATE/SecurityUpdates-last-check.json` was last written, and that state file updated for the next run.

**"/secupdates"** → same Update intent, slash-command entry.

**Second run same day** → only items whose keys are not already in the state file surface; an empty digest with "no new items since last check" is the correct result, not a failure.
