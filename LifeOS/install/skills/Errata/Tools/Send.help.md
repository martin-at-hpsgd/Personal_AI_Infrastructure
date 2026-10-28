# Send.ts - Help Documentation

Files feedback about LifeOS itself as a clean GitHub issue under the person's own `gh` account. Backs the `/feedback` command and the Errata Send intent.

## Quick Start

```bash
# 1. Record the feedback locally (prints the erratum id)
bun ~/.claude/skills/Errata/Tools/Er.ts --product --channel feedback-command "bug: the installer assumes zsh"

# 2. Draft the issue: local only, no network, nothing spawned
bun ~/.claude/skills/Errata/Tools/Send.ts draft <id> [--summary-file <path>] [--comment-on <n>]

# 3. After the person approves the exact text, file it with the hash they saw
bun ~/.claude/skills/Errata/Tools/Send.ts file <id> --confirm <sha256> [--summary-file <path>]
```

## Commands

### `draft <id>`
Builds the title and body from the complaint, kind, component, LifeOS version and an optional summary, scrubs them, and prints the target (the fixed upstream repo, and "new issue" or "comment on issue #n"), the exact text, its sha256 and everything the scrubber removed. The sha256 covers the target as well as the text.

- Never reads the erratum's `cwd`, `requested`, `response_preview`, `session_id` or `instance` into the text. When those values appear inside the complaint or summary they are struck: `cwd`, `session_id` and `instance` at 6 characters or more, `requested` and `response_preview` at 24 or more. Shorter values stay, so a short phrase the person typed is not mangled.
- Makes no network request and spawns no process.
- Refuses an erratum whose target is not `lifeos-product` (exit 3).

### `file <id> --confirm <sha256>`
Rebuilds the draft for the same target and files it only when it hashes to `--confirm`. To comment on an existing issue, approve that target first: `draft <id> --comment-on <n>`, then `file <id> --confirm <that hash> --comment-on <n>`. A hash approved for a new issue never authorizes a comment.

1. Hash mismatch: nothing is sent; the fresh draft is printed (exit 3).
2. Duplicate search: `gh issue list --repo github.com/<upstream> --state open --search <approved title>`. Matches stop the run and are listed (exit 3). A search that fails or returns unreadable output also stops the run, with nothing filed (exit 4).
3. `gh issue create` (or `gh issue comment` with `--comment-on`), run with every `GH_TOKEN`/`GITHUB_TOKEN` variable removed so `gh` uses the person's own login, `GH_HOST` and `GH_REPO` removed, and the host pinned in the `--repo` argument.
4. The URL is written to the erratum's `links.issue`.

## Options

| Option | Applies to | Effect |
|---|---|---|
| `--summary-file <path>` | draft, file | A short summary written by the session model. An optional first line `Title: ...` sets the title. Pass the same file to `file` as to `draft`, or the hash will not match. |
| `--json` | draft, file | Machine-readable output. |
| `--confirm <sha256>` | file | Required. The hash shown with the draft. |
| `--comment-on <n>` | draft, file | Comment on open issue n instead of opening a new one; skips the duplicate search. Part of the approved target: pass it to `draft` and to `file`. |
| `--new` | file | File a new issue even though the duplicate search found matches or could not run. |

## What the scrubber removes

| Rule | Removed |
|---|---|
| secret, pii, token | Vendor keys, bearer tokens, JWTs, PEM blocks, `KEY=value` pairs, emails, phone and card numbers, 32+ character mixed tokens |
| session-id | UUIDs |
| home-path | The home directory (also `~`, `$HOME`, `%USERPROFILE%`) and everything below it becomes `<home>/<path>`; `.claude` is kept as `<home>/.claude/<path>`. Separators are matched in every spelling pasted text uses: `/`, `\`, JSON-escaped `\/` and `\\`, URL-encoded `%2F` and `%5C`, and drive paths with either slash (`C:/...`). An encoded path ends at the first `&`, `#` or `?`. Folder names with spaces are followed when the next word has a separator, a capital or a digit; a file extension or lowercase word ends the path |
| system-path | Paths outside home: `/private`, `/var`, `/tmp`, `/opt`, `/Volumes`, `/mnt`, `/srv`, `/root`, `/etc`, `/usr`, `/Library`, `/Applications`, `/System`, `/proc`, `/run`, `/media`, `/snap`, `/nix`, any drive-letter path, and `$PWD`, `$TMPDIR`, `%APPDATA%`-style variables become `<path>` |
| username | The OS username, as a whole word, becomes `<user>` (skipped when shorter than 3 characters) |
| hostname, ip-address | This machine's hostname, names ending `.local .lan .internal .corp .home.arpa .ts.net`, IPv4 addresses |
| user-file-line, user-file-block | Lines quoting files under `USER/`, and any fenced block containing one |
| context-* | Literal values of the erratum's private fields found anywhere in the text |

The removal list masks secrets (first characters and length only).

## Approval boundary

The hash binds an approval to the exact text and target: `file` cannot send anything the person was not shown. It does not, by itself, prove that a person said yes, because a session that can run `draft` can read the hash and run `file`. The yes is the person's message in the session between the two commands. Do not run `file` in the same turn as `draft`; wait for the person's reply. Enforcing that with a PreToolUse hook (refuse `Send.ts file` unless a user message arrived after the `draft` output) is a harness change and is tracked outside this tool.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Drafted or filed |
| 2 | Usage error, erratum not found, or `--confirm` missing |
| 3 | Refused: wrong target, hash mismatch, duplicate candidates, already filed |
| 4 | `gh` failed, including a duplicate search that could not run |

## Environment

The upstream repo is fixed in the tool and no environment variable moves it. `ERRATA_DIR` moves the ledger, as for every Errata tool.
