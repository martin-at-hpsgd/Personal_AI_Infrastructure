# Speaking

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Speaking/Config.md && echo ok · optional

## What it does

Speaking keeps a running list of paid speaking slots that fit your topics, so a good call for proposals never closes unnoticed. You tell it what you speak on, what you charge, and where to look: people in your field who publish their talks, conferences by pay tier, speaker bureaus, and CFP boards. FindOpportunities checks those sources and updates the list with each event's deadline, pay tier, booker and next action. ShowOpportunities ranks the list by fit and days to close. ProposeTalks drafts three talks and three panels for a named event, built from positions you have written down.

**How it is usually run.** On demand ("find speaking opportunities", "show me opportunities", "propose talks for <event>"), with FindOpportunities about once a month and weekly during CFP season. You can also put the deadline check on a weekly schedule (optional; worked example below).

**Needs.** The Research skill for web lookups. Everything else is optional:

- Workflows, which ships with LifeOS, only for the scheduled deadline check.
- Vigil (see `skills/Vigil/Setup.md`), only if you want each scheduled run logged as a Vigil event. Without it, results stay in the Workflows run report and run ledger.
- ProposeTalks reads whatever files or URLs you list under `## Speaker record`, such as a notes file, a CV or a personal site. None of them has to be a LifeOS file.

## Fill in

The skill reads two files in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Speaking/`: `Config.md` (your topics and sources) and `Opportunities.md` (the tracked list). The LifeOS installer lays down a filled-in example of both there, with made-up topics, speakers, conferences, bureaus and aggregators in every section. Start from that example and replace each value with your own. If the files are missing, for example because you installed LifeOS before this skill shipped, copy both from `install/USER/CUSTOMIZATIONS/SKILLS/Speaking/` in the LifeOS release you installed from.

If you would rather start small, this is the smallest `Config.md` that works:

```markdown
---
version: 1.0.0
---

# Speaking — Config

## Topics

- **Developer productivity:** tooling, build systems, measuring engineering work
- **Data privacy:** consent design, privacy engineering

## Fee range

$3,000 - $15,000 depending on event type.

## Excluded events

- Example DevCon: I sit on its program committee.

## Speaker record

- Goals and interests: `~/Documents/speaking-goals.md`
- Published positions: https://example.com/writing
- Credentials and past talks: `~/Documents/speaker-cv.md`

## Signature talking points

**Why small maintainer teams outlast big foundations**

- Most widely used libraries have one or two active maintainers
- Funding flows to foundations, not to the people doing the work

## Speaker pages to monitor

| Speaker | Focus Areas | Source URL | Notes |
|---------|-------------|------------|-------|
| **Jordan Example** | Developer tooling | https://example.com/jordan/talks | Lists upcoming keynotes |

## Conferences

### Tier 2: Paid or honorarium

| Conference | Focus | Typical Timing | CFP/Booking |
|------------|-------|----------------|-------------|
| **Sample Privacy Forum** | Privacy engineering | September, Chicago | example.org/forum |
```

| Section | Meaning |
|---|---|
| `## Topics` | What you speak on. The fit test: nothing outside these goes on the list |
| `## Fee range` | What you charge; each event's pay tier is judged against it |
| `## Excluded events` | Events never tracked or recommended, such as ones you help run |
| `## Speaker record` | Where your goals, published positions and credentials live. Each line can point at any file or URL (a notes file, a CV, a personal site, a TELOS file if you keep one). ProposeTalks states nothing about you that is not there |
| `## Signature talking points` | Positions you have already worked out, usable as talk or panel material |
| `## Highest-yield source` | Optional. The one source checked first on every run |
| `## Speaker pages to monitor` | People who publish where they speak; their events point to conferences that pay |
| `## Conferences` | Events by pay tier (Tier 1 premium, Tier 2 paid or honorarium, Tier 3 prestige), plus `### Priority targets` to check directly |
| `## Speaker bureaus` | Optional. Bureaus to check for representation and the events they book |
| `## Extra CFP aggregators` | Optional. CFP boards for your niche, on top of the general ones in `Sources.md` |

`Opportunities.md` in the same folder is the tracked list. The installed example has empty sections, and FindOpportunities creates the file if it is missing. Each entry is a `### ` heading under a `## ` section, with bold field labels; anything under a section whose name contains "Archive" is history. One entry looks like this:

```markdown
## Priority Opportunities

### Sample Privacy Forum 2027

| Field | Details |
|-------|---------|
| **Submit** | [CFP form](https://example.org/forum/cfp) |
| **Deadline** | May 15, 2027 |
| **Pay Tier** | $$ (honorarium) |
```

### Adding your own sources

Sources are rows in Config.md; the skill reads them on the next run. FindOpportunities never edits Config.md itself; new sources it finds are listed in its summary for you to add. Each kind of source looks like this, with made-up values to replace.

A conference goes in the tier that matches what it pays: Tier 1 premium paid keynotes, Tier 2 paid or honorarium, Tier 3 prestige or exposure.

```markdown
### Tier 1: Premium paid keynotes

| Conference | Focus | Typical Timing | CFP/Booking |
|------------|-------|----------------|-------------|
| **Example Engineering Summit** | Developer productivity | April, Denver | example.com/summit |
```

A priority target is an event checked directly for CFP status on every run. It is a bullet under `## Conferences`:

```markdown
### Priority targets (check directly for CFP status)

- Example Ideas Week - example.com/ideas
```

A person to watch is a row with the page that lists their upcoming talks:

```markdown
## Speaker pages to monitor

| Speaker | Focus Areas | Source URL | Notes |
|---------|-------------|------------|-------|
| **Priya Sample** | Privacy engineering | https://example.org/priya/events | Mostly policy events |
```

A speaker bureau is a row with its name, specialty and URL:

```markdown
## Speaker bureaus

| Bureau | Specialty | URL |
|--------|-----------|-----|
| **Example Speakers Agency** | Technology, engineering | example.com/speakers |
```

A CFP board for your niche, checked on top of the general aggregators in `Sources.md`, is a bullet:

```markdown
## Extra CFP aggregators

- **Example CFP Board**: example.com/cfps (developer conferences)
```

The highest-yield source is the one source checked first on every run. It is one line with the source, its URL and why it pays off:

```markdown
## Highest-yield source

Example Conference Watch (https://example.com/events): its listings are paid developer conferences.
```

### A scheduled deadline check (optional)

A weekly check that every tracked entry still has a deadline, a contact and a pay tier, and that no deadline passed without a submission. It needs Workflows, which ships with LifeOS. Each run's findings appear in the Workflows run report and run ledger, and if you have set up Vigil, each run is also logged as a Vigil event. Skip this section if you would rather run the check by hand. Save as `LIFEOS/USER/WORKFLOWS/speaking-deadlines.workflow.yaml` and set the cron and timezone to yours:

```yaml
version: 2
name: speaking-deadlines
description: "Weekly check of the speaking opportunities list: name every entry missing a deadline, a contact or a pay tier, and every deadline that passed without a submission."
runs_on: local
destination: the run report and the run ledger
triggers:
  - type: schedule
    cron: "17 8 * * 1"
    timezone: America/Chicago
    missed_run: once
  - type: manual
steps:
  check:
    kind: command
    description: "CheckOpportunities --json: read the list and report findings. Exit 1 means findings and is still a successful run."
    side_effects: [ read ]
    timeout_ms: 60000
    argv: [ sh, -c, 'cd "$HOME/.claude" && bun skills/Speaking/Tools/CheckOpportunities.ts --json; s=$?; test "$s" -le 1' ]
    output:
      type: object
      required: [ path, findings ]
      properties:
        path: { type: string }
        findings: { type: array }
result: { $ref: steps.check.output }
```

Check it with `bun LIFEOS/WORKFLOWS/workflow.ts validate speaking-deadlines`, then install the schedule with `bun LIFEOS/WORKFLOWS/engine/schedule-install.ts install speaking-deadlines`.

## Accounts and secrets

None for this skill. Web lookups use whatever search access your LifeOS already has; no extra `~/.claude/.env` key is needed here.

## Prove it works

```bash
test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Speaking/Config.md && rg -c '^## ' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Speaking/Config.md
cd ~/.claude && bun skills/Speaking/Tools/CheckOpportunities.ts --json
```

The first command prints how many sections your Config.md has (at least `2`: Topics and Fee range). The second reads the opportunities list without changing it: exit 0 prints `"findings": []`, exit 1 lists entries to fix, and exit 2 means there is no list yet, which is expected before the first run. Then ask the assistant "find speaking opportunities". Success is a summary of new finds, urgent deadlines and archived events, and an opportunities list where every active entry has a deadline, a URL or contact, and a pay tier. If Config.md is missing, the assistant stops and points you at this file instead of guessing.
