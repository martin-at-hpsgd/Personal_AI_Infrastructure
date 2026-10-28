# CheckPullRequests

**Contents:** Ideal State · Anti-criteria · Safety gates · Inputs · Tool contract · Output format

An open-PRs report across the principal's open source repos (Config.md `OSS_REPOS`), from a live gh fetch, with a status, a quality read and a merge decision for each PR.

## Ideal State

- The same pass also sweeps each checked repo's GitHub Discussions (fetched with the PRs below) and folds unanswered Q&A into this report; issues and PRs without discussions is an incomplete community pass.
- The report covers the open PRs of the requested repo, or every repo in Config.md `OSS_REPOS` when none was named, from this session's live `gh pr list` fetch, in the Output format below.
- A section that came back `ok: false` (a hole), or a fetch that printed an `ERROR:` line, is named as a hole ("could not fetch (gh auth/scope)"); a list with `truncated: true` says "showing first 50".
- Each PR carries a category and a status from the tables in Output format, with status read from the fetched fields as each row defines it; an empty `statusCheckRollup` reads "no CI reported", not "tests pass".
- Each PR is assessed for code quality (clean, follows project conventions), test coverage, documentation, scope (appropriately sized, single concern) and breaking changes.
- Each PR carries a Decision (Merge, Request Changes, Close, or Discuss), its rationale, a specific next step, and a suggested comment if needed.
- The report prioritizes PRs from repeat contributors, flags any PRs that touch security-sensitive code, notes quick wins (small, clean, obvious value), and identifies PRs that might need to be split or that duplicate effort or conflict with each other.

## Anti-criteria

- Never renders a Good/healthy state, or zero PRs, from a section that is a hole or a fetch that printed an `ERROR:` line.
- Never fetches or reports PRs on a repo outside `OSS_REPOS`; a repo Config.md § Out of scope routes elsewhere is pointed there instead.

## Safety gates

PR handling follows the SKILL.md FIX-IN-SOURCE-FIRST gotcha: a repo that is its own source of truth merges normally; a repo Config.md § Source of truth names as generated from elsewhere never takes a merge on the public repo.

## Inputs

- **project** (optional): one repo from `OSS_REPOS`. If omitted, checks every listed repo.

## Tool contract

### Live Data (pre-injected)

Open PRs (with `statusCheckRollup`, `mergeable`, `mergeStateStatus`, `reviews`, `reviewDecision`, bodies and comments) and the 30 most recently updated discussions for every repo in `OSS_REPOS`, as one JSON object (shape and hole semantics: `Tools/Fetch.help.md`).

! `bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts prs discussions || echo "ERROR: Fetch.ts failed (auth/scope/network) — NOT zero results"`

### Intent-to-Flag Mapping

| Input | Flags |
|-------|-------|
| **project** named | `--repo <name>` (a name from `OSS_REPOS`) |
| Past a truncated list | `--limit N` |

## Output format

PR categories:

| Category | Indicators |
|----------|------------|
| **Feature** | New functionality, capability addition |
| **Bug Fix** | Fixes reported issue, error correction |
| **Documentation** | README updates, examples, comments |
| **Refactor** | Code cleanup, optimization, no behavior change |
| **Dependency** | Version bumps, security updates |
| **Breaking** | API changes, incompatible modifications |

PR status:

| Status | Criteria |
|--------|----------|
| **Ready to Merge** | `statusCheckRollup` has no failing or pending check, `reviewDecision` is APPROVED, `mergeable` is MERGEABLE, not `isDraft`, clean diff. If `statusCheckRollup` is empty the repo reports no checks: say "no CI reported", not "tests pass" |
| **Needs Review** | No reviews yet (`reviews` empty), updated within 30 days, not a draft |
| **Changes Requested** | Review feedback pending author response |
| **Stale** | `updatedAt` more than 30 days ago |
| **Conflicted** | `mergeable` is CONFLICTING or `mergeStateStatus` is DIRTY |
| **Needs Discussion** | Design questions, scope concerns |

```markdown
## Pull Requests Report

### Summary
- **Total Open PRs:** X across all projects
- **Ready to Merge:** X
- **Needs Review:** X
- **Stale:** X

### <repo> (X PRs)

#### Ready to Merge
1. **#45: [Title]** by @author
   - Changes: +X/-Y across Z files
   - Category: [Feature/Bug Fix/etc.]
   - **Recommendation:** Merge - clean PR, tests pass

#### Needs Review
1. **#52: [Title]** by @author
   - Changes: +X/-Y across Z files
   - **Summary:** [What this PR does]
   - **Concerns:** [Any red flags or things to check]

#### Stale (30+ days)
1. **#30: [Title]** - Last activity: [date]
   - **Recommendation:** [Close with comment / Ping author / Review anyway]

[One section per repo in OSS_REPOS order, same format]

### Recommended Actions (Priority Order)
1. **Merge #45 in <repo>** - Clean feature addition, tests pass
2. **Review #52 in <repo>** - Needs your input on approach
3. **Close #30** - Stale, author unresponsive, outdated approach
```
