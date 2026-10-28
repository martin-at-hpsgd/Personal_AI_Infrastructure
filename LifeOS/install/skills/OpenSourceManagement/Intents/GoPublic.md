# GoPublic

A private repo proven safe to publish, dressed to land well with strangers, and staged as a clean export, stopping at the principal's go-ahead.

## Ideal State

- A `PublicReady.ts` verdict exists for the repo before any presentation work, and every blocker it names is either fixed in the private repo's source or excluded through `.publicignore`, with the reason stated for each.
- The public tree is a `PublicReady.ts export`: one commit dated +0000, no `.publicignore` path, no remote, and its own audit reads READY with every check `pass` or a named `warn`. Private history, internal planning files (ISAs, eval proposals, design receipts) and commit-time offsets never travel.
- The README opens on the problem the project solves, in the reader's terms, before any feature list; it shows the real product (screenshots or terminal output made from synthetic data), says how it works, how to install and build it, what it sends over the network when it does, and its license.
- The repo carries a root `LICENSE` (MIT unless the principal names another), a `SECURITY.md` saying how to report a vulnerability privately, and a CI workflow that runs the same build and tests the clean-clone check ran.
- A 1280×640 social preview image exists for GitHub's repository settings, authored as HTML with inline SVG in the repo, rendered in a real browser through Interceptor, and taken through the ArtDirection loop; a shortfall against its bar is reported, never hidden.
- An independent look ran on the exact commit being exported, and the export reads READY only with `--reviewed <that sha>`; every fix made after a review gets its own review before the hand-off. The look is `LIFEOS/TOOLS/Review.ts` on the export directory, or, when that reviewer is unavailable, a fresh read-only audit agent covering what scanners miss (injection paths, webview and IPC surfaces, README claims against the code, third-party terms, build-from-README).
- A stranger can build the project from the README alone on a machine with none of the principal's identities, keys or signing certificates.
- After the push, `PublicReady.ts live <owner>/<repo>` reads all green: public, the custom social preview uploaded, private vulnerability reporting on (SECURITY.md sends reporters there), and the latest CI run passed. The repo is not called done until it does; uploading the social preview is the principal's one hand step, so the card's path is handed over with the link and the check is rerun after they upload it.
- The hand-off names the export path, the audit verdict, the exact publish commands, the description and topics to set, and the decisions that are the principal's (repo name, license, keep or rename the private repo).

## Anti-criteria

- Never pushes, never runs `gh repo create`, never changes a repo's visibility and never adds a public remote without the principal's explicit go-ahead on this repo in this conversation.
- Never rewrites or force-pushes the private repo's history to make it publishable; the export is the clean path.
- Never weakens or bypasses the public deny list (`hooks/lib/public-deny-list.ts`) or a `PublicReady` check to reach READY.
- Never puts the principal's real data in a public screenshot, fixture or example: no real IPs, network numbers, file paths, account names or personal files.
- Never calls the repo released, live or public before the push has landed and `gh repo view` reads PUBLIC.
- Never hands off an export whose independent review covered an earlier commit than the one exported.
- Never touches another session's uncommitted changes in the source repo.

## Inputs

- The repo path, and its PROJECTS.md row when it has one.
- An optional `.publicignore` at the repo root (gitignore syntax) naming private files that stay out of the export.
- The principal's choices when given: license, public repo name, whether the private repo stays.

## Safety gates

- **Publishing is P7.** The go-ahead is the principal's word naming this repo after seeing the READY export; a clean scan is the floor, never consent. With it, the push runs from the export directory, and the `PublicReady.ts` deny-list scan has already read the exact tree going out. No push hook scans it again: the per-call `PublicPushGate` was retired 2026-10-24, and the private trees' `pre-push` governs only those trees.
- **A name collision with the private repo is the principal's call.** Renaming the private repo, deleting it, or publishing under a new name are each an ASK.
- **Every edit to the source repo** checks `git status` first and commits only its own paths.

## Tool contract

**A run is a Workflow at the tier its parts set** (Router ISA F8, Algorithm § Routing; OPERATIONAL_PREFERENCES § Workflows is the opt-in): the parts this intent runs at the same time become lanes of a script written for that run, the dependent steps stay in order, and the main session stays the only writer of the deliverable.

Run from `~/.claude`.

```bash
bun skills/OpenSourceManagement/Tools/PublicReady.ts audit <repo> [--json] [--no-build] [--build "<cmd>"] [--history-ok] [--reviewed <sha>]
bun skills/OpenSourceManagement/Tools/PublicReady.ts export <repo> --out <empty-dir> [--json] [--no-build] [--build "<cmd>"] [--reviewed <sha>]
#   exit 0 READY · 1 NOT READY · 2 usage or unreadable repo; full check list in Tools/PublicReady.help.md
bun skills/ArtDirection/Tools/Critique.ts ...        # the social preview's critique panel (ArtDirection skill)
gh repo view <owner>/<repo> --json visibility -q .visibility
```

The publish step, run only after the go-ahead, from the export directory:

```bash
gh repo create <owner>/<name> --public --source <export-dir> --description "<one line>" --push
gh repo edit <owner>/<name> --add-topic <t> ...
gh api -X PUT repos/<owner>/<name>/private-vulnerability-reporting
bun skills/OpenSourceManagement/Tools/PublicReady.ts live <owner>/<name>     # exit 0 only when every live check passes
bun skills/OpenSourceManagement/Tools/PublicReady.ts live --all <owner>      # the same across every public repo the owner has
```

The social preview image is uploaded by hand in the repository's Settings → Social preview; GitHub has no API for it.

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| "is X public-ready", "can we open source X" (default) | `audit <repo>` | Verdict on the repo as it stands, history included |
| "prep it", "stage the public version" | `export <repo> --out <dir>` | Fresh-history export, audited |
| "quick check", "skip the build" | `--no-build` | Skips the clean-clone build; the verdict cannot be READY |
| "it builds with make" | `--build "make test"` | Overrides the detected build command |
| "we're flipping it as is, history included" | `--history-ok` | History metadata no longer warns |
| the independent review finished on commit X | `--reviewed X` | The `review` check passes only when X is the commit being exported |
| "is it set up properly now", after publishing | `live <owner>/<repo>` | Visibility, social preview, vulnerability reporting and CI, read from GitHub |
| "which of our repos are missing a card" | `live --all <owner>` | One line per repo with its gaps, and a count of repos fully set up |

## Gotchas

- **gitleaks exits 1 both for leaks and for its own fatal errors** (2026-10-12: an unwritable `/dev/stdout` report path read as "leaks found"). `PublicReady.ts` judges from the report file; keep it that way.
- **History leaks more than secrets.** Commit author emails and UTC offsets show where the author was on each commit date; a repo flipped public publishes all of it. The export's single commit is dated +0000 for this reason.
- **Design and eval receipts carry absolute home paths.** Critique JSON, Assay proposals and similar LifeOS artifacts embed `artifact` and `receipt` paths; they belong in `.publicignore`, not in a scrub.

- **Agents cannot be dispatched into the export directory** (2026-10-12): it has no ISA, so `DevelopmentBuildGuard` reads any Opus dispatch naming it as a builder and refuses. Aim review agents at the source repo and list the public files in the brief.
- **The OpenAI critique seat and `Review.ts` both run on the ChatGPT plan** (2026-10-12: both were unavailable on a usage cap). Report the seat as unavailable and run the fresh audit agent; never count a single-vendor critique as a pass.
- **The Interceptor DOM capture drew runtime-created SVG as nothing** (2026-10-12, on a social card: script-built shapes were missing while script-built text rendered). Write card SVG statically, from a small generator if it has repeated geometry.
- **A social preview that exists in the repo is not on the repo** (2026-10-15): the card was required and made, but nothing checked it was uploaded, and 59 of 66 public repos had none. `live` reads `usesCustomOpenGraphImage` from GitHub, so the upload is checked rather than assumed.
- **A fix after the review is unreviewed code** (2026-10-15, Share): the only review ran before its own findings were fixed, and the fix commits reached the export with no second look; the next review found new issues in them. The `review` check now fails an export whose `--reviewed` commit is not the one exported.
- **`new URL(..., import.meta.url).pathname` is percent-encoded** when the project path holds spaces or other encoded characters; use `fileURLToPath`.

## Output format

The verdict line, the check table with evidence for each non-pass, what was changed in the source repo (files and commit), the export path, the social preview path and its critique score, the publish commands ready to paste, and the open decisions for the principal as numbered one-liners.

## References

- `Tools/PublicReady.help.md` — every check, its status rules, and the export contract.
- `LIFEOS/TOOLS/lib/DenyHistoryScan.ts` and `hooks/lib/public-deny-list.ts` — the deny-list scan the audit runs over HEAD and history.
- `skills/ArtDirection/SKILL.md` — the critique loop the social preview goes through.
