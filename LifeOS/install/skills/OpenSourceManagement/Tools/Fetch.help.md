# Fetch.ts

The one live GitHub fetch behind CheckState, CheckIssues, CheckPullRequests and
CheckDiscussions: open issues, open PRs, recent discussions and repo stats for every repo in
the `OSS_REPOS` list in the skill's USER Config.md, as one JSON object.

```bash
bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts issues prs discussions stats --brief  # CheckState snapshot
bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts issues discussions                    # CheckIssues
bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts prs discussions                       # CheckPullRequests
bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts discussions --repo <name> --limit 10
```

## Flags

- Kinds (one or more): `issues`, `prs`, `discussions` (GraphQL, most recently updated first), `stats`.
- `--repo <name>`: one repo from `OSS_REPOS` instead of all of them. A name not in the list is refused
  (exit 2), never fetched.
- `--limit N`: list size. Defaults: issues and prs 50, discussions 30.
- `--brief`: drops bodies, reviews, PR comment threads and check rollups, for a cross-repo snapshot
  (issue comments stay, as sentiment evidence).

## Output

`{ owner, fetchedAt, repos: { <repo>: { <kind>: Section } } }`, where a Section is:

- `{ ok: true, items, limit, truncated }` for a list. `truncated: true` means the list hit its
  limit: report "showing first N".
- `{ ok: true, stats: { stars, forks, open_issues_and_prs, pushed_at, commits_30d } }`.
  `open_issues_and_prs` is GitHub's `open_issues_count`, which counts PRs too. `commits_30d` is
  the default-branch commit count since 30 days ago, `"100+"` at the page cap, or a hole object.
- `{ ok: false, error }` for a hole: gh failed, GraphQL returned `errors`, or the repository came
  back null (Discussions disabled or no access). A hole is reported as "could not fetch", never
  as zero items.

Exit 0 with holes inside the JSON; exit 1 with an `ERROR:` line when `OSS_OWNER` or `OSS_REPOS` is
missing or malformed in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/OpenSourceManagement/Config.md`; exit 2 on
bad arguments or a `--repo` outside the list.

## Config

```
OSS_OWNER: <github login or org>
OSS_REPOS: <repo>, <repo>, <repo>
```

Repo names are bare names under `OSS_OWNER`, comma-separated, fetched in the order written.
