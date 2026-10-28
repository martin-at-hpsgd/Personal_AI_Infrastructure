# PublicReady.ts

Is a private repo safe to make public, and the clean export that makes it so. Never pushes,
creates a repo, adds a remote or changes visibility.

```bash
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts audit <repo>                 # human report
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts audit <repo> --json          # machine report
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts audit <repo> --no-build      # fast; never READY
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts audit <repo> --build "make test"
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts export <repo> --out <empty-dir>
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts export <repo> --out <empty-dir> --reviewed <sha>
```

Exit: `0` READY · `1` NOT READY · `2` usage error or the repo is unreadable.

## After publishing

```bash
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts live <owner/repo> [--json]
bun ~/.claude/skills/OpenSourceManagement/Tools/PublicReady.ts live --all <owner> [--json]
```

Read-only `gh` calls. Checks `visibility` (PUBLIC), `social-preview` (`usesCustomOpenGraphImage`; GitHub has no upload API, so a fail names the Settings page), `vuln-reporting` (private vulnerability reporting enabled), and `ci` (latest workflow run; no runs, or a run still in progress, is a warn that keeps the repo from passing). `--all` covers every public, non-fork, non-archived repo. Exit 0 only when every repo passes.

## Checks

| id | fail | warn | unavailable |
|---|---|---|---|
| `deny-list` | `PublicPushGate`'s `scan()` hits HEAD or history (the gate would refuse the push) | | deny list unreadable or scan errored |
| `trufflehog` | any credential finding in any commit | | not installed, or errored with no output |
| `gitleaks` | any finding in its report | | not installed, or no report written |
| `home-paths` | a `/Users/<name>/` or `/home/<name>/` path in a tracked text file at HEAD | | |
| `private-ips` | | an RFC1918 address other than the placeholder gateways `192.168.1.1`, `192.168.0.1`, `10.0.0.1` | |
| `large-files` | | a tracked file over 5 MB | |
| `license` | no `LICENSE`, `LICENCE` or `COPYING` at the root | | |
| `readme` | no root README | under 40 non-blank lines, or no image | |
| `dep-licenses` | a Cargo dependency available only under copyleft terms (GPL, LGPL, AGPL, SSPL, EUPL, OSL, BUSL, NC) | a dependency declaring no license | npm projects (not checked yet), cargo unavailable, or a Cargo manifest or lockfile that differs from HEAD on disk |
| `history` | | more than one commit (emails and UTC offsets would publish) | git log failed |
| `review` | `--reviewed` names an older commit (the commits since are listed) or no commit at all | | no `--reviewed` given |
| `clean-build` | the build command fails in a fresh clone of HEAD, run by `/bin/sh` with only toolchain, locale and temp variables and no global git config (tokens, keys, signing identities and the ssh agent are dropped; files under HOME and the keychain stay reachable) | no build command detected | `--no-build`, or the clone failed |

The verdict is READY only when no check is `fail` or `unavailable`. A skipped or missing
check is never counted as a pass.

Build detection: `Cargo.toml` → `cargo test --quiet`; `package.json` → `bun install && bun test`;
`go.mod` → `go test ./...`. `--build` overrides it. The build runs in a throwaway clone,
so anything uncommitted or untracked that the build secretly needs shows as a failure.

## Export

`export` writes HEAD (via `git archive`, so uncommitted work never ships) into an empty
directory outside the source repo, drops every path matched by the source repo's
`.publicignore` (gitignore syntax; the file itself is always dropped), and commits the rest
as one commit named `Initial public release`, authored as the source repo's
`user.name`/`user.email` and dated now in `+0000`. It then audits the export with
`--history-ok` and returns that report with `exportDir` set. It refuses a non-empty target.
