# CheckState

**Contents:** Ideal State · Anti-criteria · Safety gates · Inputs · Tool contract · Output format

The comprehensive state report across all of the principal's open source repos (Config.md `OSS_REPOS`); the main intent for "let's look at our open source."

## Ideal State

- The report gives a complete picture of the current state of all projects (issues, PRs, discussions), community sentiment and health, the top priorities requiring attention, and specific recommendations with suggested responses, from this session's live fetch, in the Output format below.
- A section that came back `ok: false` (a hole), or a fetch that printed an `ERROR:` line, is named as a hole ("could not fetch (gh auth/scope)") for that repo; a list with `truncated: true` says "showing first 50" and is reconciled against `open_issues_and_prs` in that repo's stats.
- Each project carries health and sentiment read only from the fetched fields named in Output format, and items across ALL projects are ranked P0-P3 by urgency.
- The top 10 items needing attention each carry a specific action (merge, respond, close, label), a suggested response (exact text the principal can use), a time investment (Quick <5 min, Moderate 15-30 min, Significant 1hr+), and why it matters for the project/community.
- Every suggested response is copy-paste ready.
- Every security-related item is flagged P0 regardless of other factors.
- Actions that improve community sentiment are prioritized, and contributors who deserve recognition or thanks are named.

## Anti-criteria

- Never renders Health: Good, or zero activity, for a repo whose section is a hole or whose fetch printed an `ERROR:` line.
- Never states a health signal the fetch does not carry (star growth, response time, first-time contributors).
- No public response claims a fix before it landed in the source of truth and was verified by diff read-back.
- Never fetches or reports a repo outside `OSS_REPOS`; a repo Config.md § Out of scope routes elsewhere is pointed there instead.

## Safety gates

Any fix executed from this report follows the SKILL.md FIX-IN-SOURCE-FIRST gotcha.

## Inputs

- This intent should be the DEFAULT when the principal says anything about "open source" without specifying issues/PRs/discussions

## Tool contract

Live data (pre-injected): open issues, open PRs, the 30 most recently updated discussions and repo stats for every repo in Config.md `OSS_REPOS`, as one JSON object (shape and hole semantics: `Tools/Fetch.help.md`).

! `bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts issues prs discussions stats --brief || echo "ERROR: Fetch.ts failed (auth/scope/network) — NOT zero results"`

### Intent-to-Flag Mapping

| Need | Flags |
|------|-------|
| One project only | `--repo <name>` (a name from `OSS_REPOS`) |
| Past a truncated list | `--limit N` |
| Bodies, reviews, CI rollups for a shortlisted item | drop `--brief`, or run CheckIssues / CheckPullRequests |

## Output format

#### Health Indicators

Read each from the fetched fields only:
- **Activity Level:** `stats.commits_30d`, `pushed_at`, and issues, PRs and discussions with `createdAt` in the last 30 days
- **Community Engagement:** issue comment counts, discussion `comments.totalCount` and `upvoteCount`, stars and forks as a current count (no growth figure)
- **Maintenance Status:** stale items (`updatedAt` 30+ days ago), unanswered discussions (`answerChosenAt` null with zero comments)
- **Contributor Health:** authors with more than one open PR or issue, and non-maintainer authors answering discussions

#### Sentiment Analysis
Review recent issues and discussions for:
- **Positive Signals:** Thanks, appreciation, success stories
- **Negative Signals:** Frustration, complaints, abandonment concerns
- **Neutral:** Straightforward questions, feature requests

Priority levels, ranked across ALL projects:

| Priority | Category | Examples |
|----------|----------|----------|
| **P0 - Critical** | Security issues, major bugs, breaking changes | Security vuln report, data loss bug |
| **P1 - High** | Popular requests, quick wins, stale PRs ready to merge | Highly upvoted issue, clean PR waiting |
| **P2 - Medium** | Good feature requests, moderate bugs | Reasonable enhancement, edge case fix |
| **P3 - Low** | Nice-to-haves, complex changes | Major refactor request, niche feature |

```markdown
# Open Source State Report
**Generated:** [timestamp]

## Executive Summary

| Project | Issues | PRs | Discussions | Health | Sentiment |
|---------|--------|-----|-------------|--------|-----------|
| <repo> | X open | Y open | Z unanswered | [Good/OK/Needs Attention] | [emoji] |
| [one row per repo in OSS_REPOS] | | | | | |

**Overall Assessment:** [1-2 sentence summary of open source health]

**Top Priority:** [Single most important thing to address]

---

## Immediate Actions (This Session)

### 1. [Action Title] - [Project] #[number]
**Type:** [Issue/PR/Discussion]
**Why:** [Brief explanation of urgency]
**Action:** [Merge/Respond/Close/Review]
**Time:** [Quick/Moderate/Significant]

**Suggested Response:**
> [Exact text the principal can copy-paste]

### 2. [Next action...]
[...]

---

## Project Details

### <repo>
**Stars:** X | **Forks:** Y | **Open issues + PRs:** Z | **Commits (30d):** N

**Sentiment:** [emoji] [Description]
- [Supporting evidence from recent activity]

**Priority Items:**
1. [Item with recommendation]
2. [...]

**Stale Items (30+ days):**
- #X: [Title] - [Recommendation: close/ping/address]

---

[One section per repo in OSS_REPOS order, same format]

---

## Themes & Patterns

**Recurring Questions:** (consider FAQ/docs)
- [Theme 1]
- [Theme 2]

**Popular Requests:** (consider roadmap)
- [Request 1] - X mentions/upvotes
- [Request 2]

**Community Highlights:**
- @user has been helping answer questions in <repo>
- @contributor submitted 3 quality PRs this month

---

## Recommended Session Plan

If the principal has **15 minutes:**
1. [Quick action 1]
2. [Quick action 2]
3. [Quick action 3]

If the principal has **1 hour:**
1. [All quick actions above]
2. [Moderate action 1]
3. [Moderate action 2]

If the principal wants to do **deep maintenance:**
1. [All above]
2. [Significant action 1]
3. [Address stale items]
```
