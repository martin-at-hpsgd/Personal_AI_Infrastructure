---
version: 1.0.1
---

# Work tracking

Status: `bun LIFEOS/TOOLS/WorkSweep.ts --dry-run 2>&1 | grep -q '^\[WorkSweep\] repo='` · optional

## What it does

Work tracking keeps your work as GitHub Issues in one private repository that you own. Pulse's Work tab shows those issues as a kanban board. An hourly sweep opens an issue for each recent work session that has none yet and marks issues that have gone quiet as stale. Every title and body passes through a filter that redacts emails, phone numbers, keys and street addresses before anything reaches the repo.

It stays off until you bind a repository, and it refuses any repository that is not private. LifeOS asks GitHub through the `gh` command, and it asks again at least every 12 hours, so a repo that is later made public switches the system off by itself.

The folders next to the config (`WORK/MY_ORG`, `WORK/YOUR_COMPANIES`, and the sample customer and consulting folders) are notes for you and your assistant. They are separate from the repo binding.

## Fill in

**1. Create a private repo.** Any name works:

```bash
gh repo create my-work --private
```

**2. Bind it.** Edit `LIFEOS/USER/WORK/work_repo.json` and replace the placeholder with your repo:

```json
{ "$schema_version": 1, "repo": "your-github-name/my-work" }
```

Do not add a `privacy` block yourself. The loader checks the repo with `gh`, then writes that block and refreshes it.

**3. Create the labels.** `LIFEOS/USER/WORK/labels.yml` lists the 16 labels the tools use (Type, Status, Priority, Property and Agent labels, plus a marker for synced issues). The work-tracking skill that seeds them in bulk is not part of this release. This prints one `gh label create` command per label; read the output, replace `OWNER/REPO` with yours, then run it:

```bash
bun -e 'const t=await Bun.file(`${process.env.HOME}/.claude/LIFEOS/USER/WORK/labels.yml`).text(); for (const m of t.matchAll(/- name: "([^"]+)"\n\s+color: "([^"]+)"\n\s+description: "([^"]*)"/g)) console.log(`gh label create "${m[1]}" --color ${m[2]} --description "${m[3]}" --force --repo OWNER/REPO`)'
```

`--force` updates a label that already exists, so it is safe to run twice. The `Agent:` label must match `AGENT_LABEL` in `config.yaml` (default `Agent:principal`).

**4. Adjust `LIFEOS/USER/WORK/config.yaml` if you want.** Every key is optional.

| Key | Default | Meaning |
|---|---|---|
| `KANBAN_COLUMNS` | Queued, Blocked, In-Progress, In-Review, Complete | The lanes on the board, in order. |
| `POLL_INTERVAL_SECONDS` | 60 | How often Pulse reads the repo. Minimum 10. |
| `AGENT_LABEL` | `Agent:principal` | The label naming the acting assistant. |
| `CAPTURE_NATIVE`, `CAPTURE_SWEEP` | true | Turn the two capture paths on or off. |
| `CAPTURE_GOALS` | false | Reserved. The sweep no longer opens issues from goals, so this switch changes nothing today; goals without open work show in the work digest instead. Leave it false. |
| `PROJECT_PROPERTY` | website, newsletter | Maps a project name (lowercase, no spaces) to a `Property:` label. Anything unmapped gets `Property:internal`. |

**5. Restart Pulse and install the sweep.**

```bash
bash ~/.claude/LIFEOS/PULSE/manage.sh restart
bun ~/.claude/LIFEOS/TOOLS/InstallWorkSweep.ts
```

The second command installs the hourly job; `--status` checks it and `--uninstall` removes it.

## Accounts and secrets

You need a GitHub account and the GitHub command-line tool, `gh`, signed in to it. Run `gh auth login` once, and `gh auth status` shows whether it worked. LifeOS stores no GitHub token of its own; it uses the one `gh` holds. If you have no repo yet, the `gh repo create` line above makes one. The repo must be private, because issue bodies carry session detail.

## Prove it works

Ask GitHub whether the repo is private:

```bash
gh repo view your-github-name/my-work --json visibility,isPrivate
```

Then run the sweep without changing anything:

```bash
bun LIFEOS/TOOLS/WorkSweep.ts --dry-run
```

The first line should read `[WorkSweep] repo=your-github-name/my-work ... DRY RUN`. If the system is off it prints `[WorkSweep] disabled:` followed by the reason instead, such as `gh re-verify failed`, which means the placeholder is still in `work_repo.json` or `gh` cannot see the repo. A dry run exits 0 either way, so the status line at the top of this guide pipes it through `grep`, which exits 0 only when a repo is bound.

With Pulse running, `curl -s http://127.0.0.1:31337/api/work` returns a body containing `setup_required` until the repo is bound, and your issues after.

For the whole-install view, run `bun LIFEOS/TOOLS/SetupInventory.ts status`.
