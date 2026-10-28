---
metadata:
  short-description: "Triage your open-source repos via gh, take a private repo public safely, keep edit-in-place marker comments, find new Ollama models."
name: OpenSourceManagement
evals:
  manual:
    reason: "repository and local-model state are live and account-bound"
    falsifier: "a reported issue, PR, discussion, marker state, or installed-model status disagrees with the queried source"
version: 1.4.3
description: Triages open issues, pull requests and GitHub Discussions across the principal's own open-source repos (the list in Config.md) via the gh CLI, ranks what needs attention with suggested replies, posts edit-in-place marker comments, diffs new Ollama library models against a local model box, and takes a private repo public (readiness audit, fresh-history export, README and social image), stopping at the principal's go-ahead. USE WHEN open source issues, pull requests, check PRs, review PRs, check issues, community discussions, community activity, what needs attention, open source state, marker comment, triage comment, new open source models, latest open-weight models, what should I pull into Ollama, do we have this model, new Ollama models, local models, is this repo public-ready, take this repo public, open source this, public release on GitHub. NOT FOR triaging repos outside the configured list, LifeOS releases, internal work trackers, or running/prompting local models.
---

# OpenSourceManagement

**Contents:** Ideal State · Intent Routing · Repos · Quick Reference · Data & Config · Gotchas · Examples

Triages and manages GitHub activity across the principal's open source repos, the `OSS_REPOS` list in Config.md. Repos outside that list are out of scope; when Config.md routes one elsewhere (for example a repo another skill triages), point there. Through the `gh` CLI it checks and prioritizes issues, recommends which PRs to merge or review, reads discussions, gives a cross-repo state snapshot, and posts a single bot comment that edits in place via hidden HTML markers instead of stacking new comments each time.

## Ideal State

- Every report comes from this session's live `gh` fetch, structured per repo, with items ranked by urgency and impact, each repo's community mood rated (positive, neutral, negative), and specific next actions with suggested responses, written direct and actionable.
- A fetch that failed or hit its limit is named as a hole or a truncation, never rendered as a quiet repo.
- No public "fixed", "merged" or "done" claim goes out before the change lands in the source of truth (Gotchas: FIX-IN-SOURCE-FIRST), and a recurring bot note is one marker comment edited in place, never a stack.
- A private repo goes public only as an audited, fresh-history export that reads READY, with a problem-first README, a license and a social preview image, and only on the principal's word naming that repo.
- Local-model checks name what is new in the Ollama library, whether each fits and is already on the local model box, and leave every pull to the principal.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **CheckIssues** | "check issues", "open source issues", "<repo> issues" | `Intents/CheckIssues.md` |
| **CheckPullRequests** | "check PRs", "pull requests", "review PRs", "open PRs" | `Intents/CheckPullRequests.md` |
| **CheckDiscussions** | "check discussions", "community discussions", "what are people asking" | `Intents/CheckDiscussions.md` |
| **CheckState** | "open source state", "project state", "check our open source", "what needs attention" | `Intents/CheckState.md` |
| **PostMarkerComment** | "post triage comment", "leave a marker comment", "edit-in-place comment", "update bot comment", "upsert comment" | `Intents/PostMarkerComment.md` |
| **LocalModels** | "new open source models", "latest open-weight models", "what should I pull", "do we have <model>", "new Ollama models" | `Intents/LocalModels.md` |
| **GoPublic** | "is X public-ready", "take this repo public", "open source this", "prep X for public release" | `Intents/GoPublic.md` |

| File | Read when |
|------|-----------|
| `Tools/` | `Tools/Fetch.help.md` holds the triage fetch's kinds, flags, config keys and hole semantics; `Tools/LocalModels.help.md` holds LocalModels flags and column semantics; `Tools/PublicReady.help.md` holds every public-readiness check and the export contract |
| `Setup.md` | first-time setup: Config.md keys, the gh login, the optional model host, a proof command |

## Repos

The repos come from Config.md, never from this skill:

```
OSS_OWNER: <github login or org>
OSS_REPOS: <repo>, <repo>, <repo>
OSS_PRIORITY: <repo>        # optional: triaged first in batch work
```

`Tools/Fetch.ts` reads `OSS_OWNER` and `OSS_REPOS` at run time and loops over the list in the order written; `--repo <name>` narrows to one listed repo and refuses any other. Every intent's per-repo section repeats once per listed repo. Config.md § Source of truth and § Out of scope carry the per-repo routing the gotchas below rely on.

## Quick Reference

```bash
# The one live fetch every triage intent pre-injects (JSON; a failed call is a hole, never an empty list)
bun ~/.claude/skills/OpenSourceManagement/Tools/Fetch.ts <issues|prs|discussions|stats>... [--repo <name>] [--limit N] [--brief]

# Marker-backed comment upsert (edit-in-place, never stack)
bun run ~/.claude/skills/OpenSourceManagement/Tools/MarkerComment.ts \
  upsert <owner>/<repo> <number> <marker-id> <body-file> [--dry-run]
bun run ~/.claude/skills/OpenSourceManagement/Tools/MarkerComment.ts \
  find <owner>/<repo> <number> <marker-id>

# Is a repo safe to publish, and its clean fresh-history export (never pushes)
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts audit <repo> [--json] [--no-build]
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts export <repo> --out <empty-dir>

# Newest Ollama library models vs the local model box (host from Config.md)
bun ~/.claude/skills/OpenSourceManagement/Tools/LocalModels.ts [--json] [--limit N] [--host <ssh>] [--local]
```

## Data & Config

Everything install-specific lives in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/OpenSourceManagement/Config.md`; first-time setup and a proof command are in [Setup.md](Setup.md).

- `OSS_OWNER`, `OSS_REPOS`, `OSS_PRIORITY` — `KEY: value` lines; `Tools/Fetch.ts` reads the first two.
- `## Source of truth` — prose naming any listed repo that is generated or synced from another tree, and where that tree is. Read it before any fix.
- `## Out of scope` — prose naming repos this skill must not triage and where they go instead.
- `## Local Model Host` — the local model box's ssh alias and ollama binary; `Tools/LocalModels.ts` reads that table at run time; no hostnames live in this skill.

When `OSS_OWNER` or `OSS_REPOS` is missing, `Fetch.ts` prints an `ERROR:` line and fetches nothing; point the principal at `Setup.md`.

## Gotchas

- **FIX-IN-SOURCE-FIRST.** Every accepted change — a PR merge, an issue fix, a discussion-driven change — lands in the code's actual source of truth BEFORE any public "fixed/merged/done" response. The two halves are one action: fix in source + respond publicly. Source-of-truth routing comes from Config.md § Source of truth:
  - **A repo not named there** is its own source of truth: direct merges on the public repo stand. If the change also touches a local copy Config.md says mirrors that repo (vendored code, docs or tools that reference it), update the local copy in the same pass.
  - **A repo named there as generated or synced from another tree** (a release script that rebuilds the public repo from a private source, for example) never takes a merge on the public repo: port the change into the named source first, credit the contributor, and close the PR; the next sync carries it. A change made only on the public repo is wiped by the next sync.
  - **"Already fixed" closes** require verifying the fix is present in the source of truth this session (Read/diff evidence), not just absent from public main.
- **Covers the `OSS_REPOS` list only.** Not every repo the owner has; a repo in Config.md § Out of scope goes where that section says.
- **Community sentiment can be negative during breaking changes.** Frame triage responses constructively.
- **Batch work starts with `OSS_PRIORITY` when it is set,** usually the repo with the most community activity.
- **Use marker comments for any rolling bot-authored note.** The default `gh issue comment` posts a new comment every time — wrong for triage status, weekly digests, per-PR summaries. Reach for `PostMarkerComment` instead. Marker IDs must be `<intent>-<purpose>` and unique per (issue, kind); two intents MUST NOT share a marker on the same issue or they will overwrite each other.
- **LocalModels scrapes ollama.com HTML; there is no public JSON API for the library.** Class names drift, and the served HTML splits tag attributes across lines, so the parser collapses ALL whitespace before matching; normalizing newlines alone leaves every size and capability blank. Every field is best-effort: a blank column is a parser miss, not a missing model. Fix the regex, never hard-fail.
- **A library model's VRAM fit is on total params, not active.** MoE models load every expert. A 118B-A8B model is a 118B load.
- **Always `--dry-run` first against a public community repo.** Comment bodies are public and permanent in the timeline even after edit. Inspect the body, confirm the marker ID, then drop `--dry-run`.

## Examples

**Example 1: Check all open source state**
```
User: "Let's look at our open source issues"
→ Invokes CheckState intent
→ Fetches issues, PRs, discussions across every repo in OSS_REPOS
→ Analyzes sentiment and priority
→ Returns comprehensive state report with recommendations
```

**Example 2: Check one repo's issues**
```
User: "Check widget issues"   (widget is in OSS_REPOS)
→ Invokes CheckIssues intent
→ Fetches open issues from $OSS_OWNER/widget (--repo widget)
→ Categorizes by type (bug, feature, question)
→ Returns prioritized list with recommended responses
```

**Example 3: Review pull requests**
```
User: "Any PRs need attention on widget?"
→ Invokes CheckPullRequests intent
→ Fetches open PRs from $OSS_OWNER/widget
→ Summarizes each PR's purpose and status
→ Recommends which to merge, review, or discuss
```
