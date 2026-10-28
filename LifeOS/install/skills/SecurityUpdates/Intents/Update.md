# Update

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Tool contract

A ranked, deduplicated security digest of what is new across the configured sources since the last check, with run state saved for next time.

## Ideal State

- The digest draws on every configured source, fetched in parallel: the six defaults in `sources.json` as swapped or extended through PREFERENCES.md, with any "Extra sources" it lists added to the fetch list; an absent PREFERENCES.md means the six defaults only.
- The digest is deduplicated: the same story from multiple sources collapses to one entry (the same story from Krebs and THN is one line, not two).
- The digest is categorized: every item sorts into 🔴 News (breaches and leaks, ransomware, state-sponsored and other active attacks, major vulnerability exploitations, company security incidents), 🔬 Research (new CVEs and vulnerability disclosures, papers, attack techniques, tool releases, bug bounty findings), or 💡 Ideas (opinions, trends, strategy, predictions, career and hiring, regulatory and compliance news, security culture).
- The digest is ranked: within each category, items are ordered by impact, recency, actionability, and novelty.
- The digest is capped: max 32 items total, ~10-12 per category; a sparse category lets others expand.
- Each item is 1-2 sentences with its source attributed, and the whole digest is rendered in the Output format below.
- Each summary is written as a summary of the source's listing, never quoted as article text: WebFetch returns a small model's summary of the page, not its content.
- The digest carries nothing an earlier run showed, dated or undated: every candidate passes through `Digest.ts filter` before ranking, and an empty "no new items since last check" digest is the correct result, not a failure.
- After a successful run, the state file holds the updated `last_check_timestamp` and a key for every item the digest showed (`Digest.ts record`), and the saved digest passes `Digest.ts check`.

## Anti-criteria

- Never exceed 32 items.
- Never fabricate headlines or CVEs.
- Never treat a missing state file as an error: it is a first run, and that is normal.
- Never pull from random security blogs: the sources are the six defaults in `sources.json`, swapped or extended only through PREFERENCES.md.

## Output format

```markdown
# Security Updates
**Generated:** [YYYY-MM-DD HH:MM TZ]
**Sources Checked:** [list of sources that responded]
**Period:** Since [last check date or "First run"]

---

## 🔴 Security News (Breaches & Incidents)

1. **[Headline]** - [1-2 sentence summary]. [Source]

---

## 🔬 Security Research

1. **[Headline]** - [1-2 sentence summary]. [Source]

---

## 💡 Security Ideas

1. **[Headline]** - [1-2 sentence summary]. [Source]

---

## 📊 Summary
| Category | Count | Top Item |
|----------|-------|----------|
| News | X | [headline] |
| Research | X | [title] |
| Ideas | X | [title] |

**Total:** X/32 items | **Next check:** Run `/secupdates` anytime
```

## Inputs

`~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/SecurityUpdates/PREFERENCES.md`, if it exists: its "Extra sources" join the fetch list below.

## Tool contract

Run from `~/.claude`. State lives at `~/.claude/LIFEOS/MEMORY/STATE/SecurityUpdates-last-check.json`; `Digest.ts` reads and writes it (creating `MEMORY/STATE/` if it is missing), so the file is never edited by hand. Full flags and exit codes: `skills/SecurityUpdates/Tools/Digest.help.md`.

Launch parallel WebFetch requests to every source URL: the six in `sources.json` (see SKILL.md § Sources) plus any PREFERENCES.md extras.

**WebFetch prompt for each:**
> "Extract all article headlines and summaries from this security site. For each item, provide: title, article URL, 1-2 sentence summary, publication date if available. Focus on content from the last 7 days."

Collect every fetched item into a JSON array of `{title, source, url?, date?}` (`source` is the id from `sources.json`) and save the digest you render to a file, both in the session scratch directory, then:

```bash
bun skills/SecurityUpdates/Tools/Digest.ts filter < candidates.json     # → {first_run, since, items}: rank only these
bun skills/SecurityUpdates/Tools/Digest.ts check digest.md              # exit 0 before the digest is shown
bun skills/SecurityUpdates/Tools/Digest.ts record < shown.json          # the items the digest showed, after a successful run
```

### Intent-to-Flag Mapping

| Step | Command | Notes |
|------|---------|-------|
| Drop anything shown before | `filter` | Keyed by canonical URL, or normalized title when there is no URL, so undated items are caught too |
| Verify the digest shape | `check <digest.md>` | Heading, three sections, summary table, at most 32 items, counts agree; also checks the state schema |
| Save what was shown | `record` | Adds each shown item's key, prunes keys older than 90 days, refuses more than 32 items |
| Use another state file | `--state <path>` | Tests and dry runs |

State file shape (written only by `record`):

```json
{
  "last_check_timestamp": "2026-01-22T12:00:00.000Z",
  "seen": {
    "3f2a9c1e0b7d4a65": {
      "first_seen": "2026-01-22T12:00:00.000Z",
      "title": "tl;dr sec #XXX",
      "source": "tldrsec"
    }
  }
}
```

### First Run Behavior

If the state file is missing, `filter` reports `first_run: true`:
- Treat as first run
- Fetch last 7 days of content (`filter` drops dated items older than that)
- Set period as "Last 7 days (first run)"
- Initialize state after completion with `record`
