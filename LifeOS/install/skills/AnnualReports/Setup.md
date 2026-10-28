# AnnualReports

Status: bun run ~/.claude/skills/AnnualReports/Tools/ListSources.ts · optional

## What it does

AnnualReports keeps a local catalog of several hundred cybersecurity annual reports (threat intelligence, breaches, ransomware, AppSec, cloud, identity and more) built from a public GitHub list. It can list the catalog by category, search by vendor, download a report page, and help the assistant synthesize trends across vendors. It needs only internet access and Bun. No account, key or personal file is required.

## Fill in

Nothing is required. A seed catalog ships as sources.json in the skill's Data folder, and each update refreshes it from the upstream list.

To override defaults, create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/AnnualReports/PREFERENCES.md`. Smallest working example:

```markdown
# AnnualReports preferences

- Favor reports from the last two years.
- Always list the vendors that were left out of a synthesis.
```

| Field | Meaning |
|---|---|
| Any prose bullet | Read by the assistant and applied over the skill defaults. There is no fixed schema. |

Optional: so vendor sites can reach you, create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/AnnualReports/Config.md` with a fenced yaml block containing `contact: you@example.org`. FetchReport then sends `LifeOS-AnnualReports/1.0 (you@example.org)` as its user agent; without it, it sends `LifeOS-AnnualReports/1.0`.

## Accounts and secrets

None. The update reads the public raw README of the upstream list (`raw.githubusercontent.com`) without authentication. No `.env` keys are used.

## Prove it works

```bash
bun run ~/.claude/skills/AnnualReports/Tools/UpdateSources.ts --dry-run
```

Success: it prints the upstream fetch, a nonzero `Total parsed:` figure, the `New reports:` and `Removed reports:` counts against the shipped seed (often zero), and ends with `Dry run - no changes saved`.

```bash
bun run ~/.claude/skills/AnnualReports/Tools/UpdateSources.ts && bun run ~/.claude/skills/AnnualReports/Tools/ListSources.ts
```

Success: the second command prints `Annual Security Reports`, a `Total Reports:` figure and the category list. If `Data/sources.json` has been deleted, ListSources exits 1 with `No source catalog at ... Run: bun run .../UpdateSources.ts`.
