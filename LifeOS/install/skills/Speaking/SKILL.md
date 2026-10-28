---
metadata:
  short-description: "Find and rank paid speaking opportunities and conference CFPs by fit, urgency, and deadline. Excludes podcasts and general media appearances."
name: Speaking
evals:
  deterministic:
    - command: "bun skills/Speaking/Tools/CheckOpportunities.ts"
      falsifier: "exit 1: an active entry in the opportunities list lacks a close date, a URL or contact, or a pay tier, or its deadline has passed without a submission or an Archive move"
  manual:
    reason: "topic fit and whether a reported deadline or fee is still true come from changing conference sources"
    falsifier: "a recommended opportunity has no verifiable CFP or booking source, a reported deadline is wrong, or the ranking conflicts with the stated fit criteria"
version: 1.2.2
description: Finds and tracks paid speaking opportunities that fit your own topics by scraping conference CFPs and speaker pages, ranks them by fit and urgency with deadlines, and drafts talk and panel proposals. USE WHEN speaking engagements, speaking opportunities, find speaking, conferences, keynote, CFP, paid speaking, where should I speak, propose talks, panel topics. NOT FOR media appearances, podcasts, or general PR.
---

# Speaking

Discovers and tracks paid speaking opportunities that fit the topics you list in Config.md. FindOpportunities scrapes conference CFPs and monitors speaker pages, then updates the opportunities list; ShowOpportunities analyzes fit, prioritizes by urgency, and returns recommendations with CFP deadlines; ProposeTalks drafts talk and panel proposals to send an organizer. Paid speaking slots get filled months ahead and the good ones close their CFPs quietly; miss the deadline and the opportunity is gone for a year, so the skill watches the sources, keeps a running list, and flags what fits and what is about to close.

**Topics (the fit test for every intent):** the `## Topics` list in Config.md (§ Data & Config). An event listed under `## Excluded events` there is never tracked or recommended, whatever its fit.

**Urgency windows (every intent):** Immediate (urgent) means the CFP or submission closes within 14 days, or is rolling; High Priority means it closes in 15-30 days; Worth Watching means it closes later or the CFP is not open yet.

## Ideal State

- The tracked list holds only paid (or flagged very-high-prestige) opportunities that fit the Config.md topics, each with its CFP close date, pay tier and next action. Unpaid community meetups appear only when the user asks for them.
- Nothing closes unnoticed: deadlines inside the Immediate window surface as urgent, and past events move to the archive with their outcome instead of disappearing.
- Every recommendation is specific to its opportunity, carries its submission deadline, and carries a URL or contact to act on.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **FindOpportunities** | "find speaking opportunities", "update speaking list", "check speaking sources" | `Intents/FindOpportunities.md` |
| **ShowOpportunities** | "show me opportunities", "what speaking opportunities", "analyze speaking list", "where should I speak" | `Intents/ShowOpportunities.md` |
| **ProposeTalks** | "propose talks", "talk ideas for a conference", "panel topics", "what could I speak on" | `Intents/ProposeTalks.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup, what Config.md holds, adding your own sources, a scheduled deadline check, proving the skill works |
| `Sources.md` | the kinds of source to check (speaker pages, conferences, bureaus, CFP aggregators), what each yields, and how often; the actual sources are in Config.md |
| `Tools/CheckOpportunities.ts` | checking the opportunities list for entries missing a close date, a URL or contact, or a pay tier, and for past deadlines left outside Archive (`--json`, `--today YYYY-MM-DD`, optional list path; exit 0 clean, 1 findings, 2 unreadable) |
| `Patterns/` | `recommend_talkpanel_topics/system.md` is the system prompt ProposeTalks runs to turn the speaker's goals, positions and interests into talk or panel proposals for an organizer |

## Data & Config

First-time setup, the Config.md fields, accounts and a proof command: [Setup.md](Setup.md). configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. If Config.md is missing, stop and point the user at Setup.md; never guess topics, fees or sources.

- **Config:** `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Speaking/Config.md` holds `## Topics`, `## Fee range`, `## Excluded events`, `## Speaker record` (where goals, positions and credentials come from), `## Signature talking points`, `## Highest-yield source`, `## Speaker pages to monitor`, `## Conferences` (by pay tier, plus priority targets), `## Speaker bureaus` and `## Extra CFP aggregators`.
- **Opportunities list:** `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Speaking/Opportunities.md`, written by FindOpportunities and read by the other intents. Created on the first run when absent.

## Gotchas

- None recorded yet.

## Examples

```
User: "Find speaking opportunities"
→ FindOpportunities
→ The opportunities list gains the new finds, and the user gets what's new, what closes within two weeks, and what was archived
```

```
User: "Update the speaking list"
→ FindOpportunities
→ An incremental update since the last run: new opportunities added, expired ones archived with their outcome
```

```
User: "Show me opportunities"
→ ShowOpportunities
→ Opportunities bucketed by urgency and fit, each with its deadline, pay tier and one specific next step
```

```
User: "Propose some talks for Example Engineering Summit"
→ ProposeTalks
→ Three talk abstracts and three panel topics fitted to that event, ready to paste to the organizer
```
