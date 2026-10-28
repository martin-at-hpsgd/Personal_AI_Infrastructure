# FindOpportunities

Discover and update paid speaking opportunities by monitoring speaker pages, conferences, and CFPs.

## Ideal State

- The opportunities list (SKILL.md § Data & Config) is updated with every new opportunity found on the speaker pages, conferences, priority targets, bureaus and CFP aggregators in Config.md, each added with event name and URL, date and location, CFP deadline, estimated pay tier, topics accepted, and source (how we found it).
- Every tracked opportunity answers the five questions that decide whether to pursue it, from a check of its CFP made on this run: whether the CFP is open, when it opens and when it closes; proof the slot pays and where its fee tier lands against `## Fee range` in Config.md; one line of fit rationale naming which topic it hits (`## Topics` in Config.md); the booker the event names for speaker submissions (a published CFP contact, speaker-relations address or submission form), or none when the event names none; and the next action (submit, email the booker, or wait for the CFP to open).
- For each high-priority opportunity, the list holds a contact table limited to the names, titles and addresses the event itself publishes (its speaker-relations or CFP page, contact page or call for proposals), with the page each came from; no profile hunting on other sites and no research on the people, plus the submission pathways (CFP forms and URLs, nomination processes, advisory board members who could refer).
- Existing opportunities carry current status: a good-fit CFP closing inside the Immediate window is flagged urgent and one closing inside the High Priority window is flagged high priority, a submitted application is tracked, and past events are moved to the "Archive" section with their outcome. New sources discovered where monitored speakers are speaking are named in the summary as candidates for Config.md.
- What was checked and when is tracked, so the next run (monthly or on-demand) is an incremental update.
- The list passes `Tools/CheckOpportunities.ts` (exit 0) after the update, or the summary names each remaining finding and why it stands.
- The user gets a summary in the output format below (new opportunities, urgent CFPs inside the Immediate window in SKILL.md, status changes, archived events), as concise bullet points per opportunity that include event name, dates, pay tier, CFP deadline, and relevance to the Config.md topics.

## Anti-criteria

- Never surfaces unpaid speaking opportunities (unless very high prestige); an unpaid or unknown-fee slot that is listed is flagged as such, not left implied.
- No entry without a close date: the close date is what ranks the list.
- No opportunity on the list without a fit: if nothing fits, it does not belong on the list.
- Never tracks an event listed under `## Excluded events` in Config.md.
- Never edits Config.md: newly found sources are proposed in the summary, and the user adds them.
- Never deletes an expired opportunity: it is archived with its outcome, because that history is how next year's cycle gets found earlier.

## Output format

```
## New Opportunities Found

[List new opportunities with key details]

## Urgent (CFP Closing Soon)

[Any CFPs inside the Immediate window: closing within 14 days, or rolling]

## Updated

[Any status changes to existing opportunities]

## Archived

[Events that have passed]
```

## Tool contract

**The researcher fleet runs through `workflows/ResearchFanout.js`** (Router ISA F8): `Workflow({name: "ResearchFanout", args: {question, researchers: [{key, prompt, agentType}], tier, stakes: "public"}})`, with the researchers this intent names as the `researchers` list. The tier follows Algorithm § Routing: 3 for three or four researchers, 4 for five or more. The script fails open on a deadline, merges the findings into sourced claims, and keeps every source it could not check; the report is written from what it returns.

Run from `~/.claude` after updating the list:

```bash
bun skills/Speaking/Tools/CheckOpportunities.ts [listPath] [--json] [--today YYYY-MM-DD]
#   exit 0 clean, 1 findings (one line each: entry [section]: problem), 2 list unreadable
```

### Intent-to-Flag Mapping

| Need | Flag |
|------|------|
| Check the live list | (no flags) |
| Findings as data for the summary | `--json` |
| Check against a date other than today | `--today YYYY-MM-DD` |
| Check a different list file | `listPath` |

Full usage: `Tools/CheckOpportunities.help.md`.

## Inputs

- The opportunities list (SKILL.md § Data & Config): the existing entries and its Last Updated date.
- Config.md (SKILL.md § Data & Config): topics, fee range, excluded events, and the speaker pages, conferences, bureaus and extra aggregators to check, with `## Highest-yield source` checked first.
- `Sources.md`: what each kind of source yields, the generic CFP aggregators, and how often to check each.
- A monitored speaker appearing at an event means it probably pays.

## References

- `Research` skill: web lookups of the event's own published pages.
