# CheckIssues

An open-issues report across the principal's open source repos (Config.md `OSS_REPOS`), from a live gh fetch, with categories, priorities, sentiment and suggested responses.

## Ideal State

- The same pass also sweeps each checked repo's GitHub Discussions (fetched with the issues below) and folds unanswered Q&A into this report; issues and PRs without discussions is an incomplete community pass.
- The report covers the open issues of the requested repo, or every repo in Config.md `OSS_REPOS` when none was named, from this session's live `gh issue list` fetch, in the Output format below.
- A section that came back `ok: false` (a hole), or a fetch that printed an `ERROR:` line, is named as a hole ("could not fetch (gh auth/scope)"); a list with `truncated: true` says "showing first 50".
- Each issue carries a category and a Critical/High/Medium/Low priority from the tables in Output format, and each project an overall sentiment (Positive, Neutral, Negative).
- Top priority issues each carry an Action (respond, fix, close, label), suggested reply text where engagement is needed, and an effort estimate (quick fix, moderate, significant).
- The report focuses on actionable items the principal can address quickly, starts with the repo Config.md names in `OSS_PRIORITY` when one is set, highlights community members who are active contributors, flags issues that might become PR opportunities, and notes duplicates that can be consolidated.

## Anti-criteria

- Never renders a Good/healthy state, or zero issues, from a section that is a hole or a fetch that printed an `ERROR:` line.
- Never fetches or reports a repo outside `OSS_REPOS`; a repo Config.md § Out of scope routes elsewhere is pointed there instead.

## Safety gates

Any fix executed from this intent follows the SKILL.md FIX-IN-SOURCE-FIRST gotcha.

## Inputs

- **project** (optional): one repo from `OSS_REPOS`. If omitted, checks every listed repo.

## Tool contract

### Live Data (pre-injected)

Open issues (with bodies and comments) and the 30 most recently updated discussions for every repo in `OSS_REPOS`, as one JSON object (shape and hole semantics: `Tools/Fetch.help.md`).

! `bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts issues discussions || echo "ERROR: Fetch.ts failed (auth/scope/network) — NOT zero results"`

### Intent-to-Flag Mapping

| Input | Flags |
|-------|-------|
| **project** named | `--repo <name>` (a name from `OSS_REPOS`) |
| Past a truncated list | `--limit N` |

## Output format

Issue categories:

| Category | Indicators |
|----------|------------|
| **Bug** | "bug", "error", "broken", "not working", crash reports |
| **Feature Request** | "feature", "request", "would be nice", "suggestion" |
| **Question** | "how to", "?", "help", "confused" |
| **Documentation** | "docs", "readme", "example", "tutorial" |
| **Enhancement** | "improve", "better", "optimize", "performance" |

Priority levels:

| Priority | Criteria |
|----------|----------|
| **Critical** | Security issue, major bug affecting many users, blocking issue |
| **High** | Popular request (many comments/reactions), easy win, good first issue |
| **Medium** | Valid request, moderate effort, some community interest |
| **Low** | Edge case, nice-to-have, requires significant discussion |

For each project, assess overall community sentiment:
- **Positive:** Appreciation, enthusiasm, constructive suggestions
- **Neutral:** Straightforward questions, factual reports
- **Negative:** Frustration, complaints, abandonment concerns

```markdown
## Open Source Issues Report

### Summary
- **Total Open Issues:** X across all projects
- **Critical:** X | **High:** X | **Medium:** X | **Low:** X
- **Overall Sentiment:** [Positive/Neutral/Negative]

### <repo> (X issues)
**Sentiment:** [emoji + description]

#### Priority Issues
1. **#123: [Title]** - [Category]
   - Created: [date] by [author]
   - Comments: X
   - **Action:** [recommendation]
   - **Suggested Response:** "[response text]"

[One section per repo in OSS_REPOS order, same format]

### Recommended Actions (Top 5)
1. [Specific action with issue reference]
2. [...]
```
