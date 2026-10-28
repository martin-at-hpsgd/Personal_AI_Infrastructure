---
version: 2.0.0
---

# Security guards

Status: `bun LIFEOS/TOOLS/SkillHygieneGate.ts` · required

## What it does

LifeOS lets your assistant run commands, push code, send mail and deploy. Three layers keep that safe, and `LIFEOS/DOCUMENTATION/Security/README.md` describes each one in full.

1. The Security Protocol in the system prompt. The model treats web pages, mail, files and other people's tool output as information, never as orders, and reports any embedded instruction to you. This is the main defense for outside content. Nothing tags or tracks content after it is read.
2. Native Claude Code permission rules in `settings.json`. The `deny` and `ask` rules block irrecoverable shell and file operations, raw deploys, purchases, inline legacy scripting and reads of `.env` before any model decision, for the main session and every subagent. Managed settings can lock them so no project file loosens them.
3. Git hooks and the subagent sandbox. A `pre-commit` hook refuses a plaintext `.env`, secret-shaped values and, in the system tree, your own names and addresses. A `pre-push` hook refuses any remote that GitHub does not confirm is private. On macOS a subagent's shell runs under a Seatbelt profile that refuses writes to your private trees' git internals.

No LifeOS hook reads a tool call to decide whether it may run. Whether a command prompts you is up to the permission rules alone.

The files below feed the parts that work from your own data. The pattern files keep your names out of skills, releases and anything you make public. The owned-hosts list tells the texting guard which of your sites a locked text session may fetch.

An empty file is the safe state. With nothing listed, nothing counts as yours and every pattern gate runs on its generic starters.

## Fill in

Everything lives in `LIFEOS/USER/SECURITY/`. Each file ships empty or with generic starters. Use placeholders like `example.com` below and replace them with your own values.

| File | Shape | What reads it |
|---|---|---|
| `owned-hosts.json` | `["example.com"]` | Domains you own. Subdomains count too. A text session that has not passed the countersign may fetch these sites and no others. |
| `texting-locked-clis.json` | `{ "rows": [] }` | Optional. Extra read-only tools a locked text session may run. Each row is `{ "rel": "<path under ~/.claude>", "subs": [], "flags": [], "maxPositional": 0 }`. |
| `outbound-shapes.json` | `{ "rows": [] }` | Optional. Extra command shapes that count as sending something out, used when the security ledger (`LIFEOS/TOOLS/SecurityHarvest.ts`) classifies past tool calls. Each row is `{ "pattern": "<regex>", "flags": "", "class": "<label>" }`. |
| `injection-surfaces.ts` | exported arrays `SURFACES`, `CAPABILITIES`, `CONTROLS` | Optional. Adds your own places where other people's text can reach the assistant to the injection census. The header comment shows the row shapes. |
| `SkillNamePatterns.txt` | one regular expression per line, `#` comments | Names that must never appear inside a skill: your surname, company, a private product name. |
| `DENY_LIST.txt` | one regular expression per line, `#` comments | Strings that must never appear in anything you publish: names, addresses, hostnames. The `pre-commit` leak scan and the skill gate read it. The shipped file holds generic starters. Keep at least 20 patterns, because the skill gate refuses to scan against a shorter list. |
| `PublicScrubPatterns.txt` | one expression per line, `#` comments | Patterns scanned in a repository and its history before it goes public. Generic secret signatures are built in, so the gate works even before you add any. |

Three older files, `owned-email-domains.json`, `owned-github-owners.json` and `egress-rules.json`, still ship as empty templates. Nothing reads them since the per-call guards were removed, so you can leave them as they are.

Two files live in `LIFEOS/USER/CONFIG/`:

- `denyhash-allowlist.txt`: one lowercase word per line. A word that looks like a private name to the hash tool but is harmless for you goes here.
- `banned-collocations.json`: a list of `{ "label": "...", "pattern": "<regex>" }` rows. The assistant's own prose is checked against them, so you can ban phrases you never want in what it writes.

To turn your private files into a salted-hash filter that catches new names without storing them in the clear, run `bun LIFEOS/TOOLS/DeriveDenyHashes.ts --dry-run` first. It prints counts and writes nothing. Run it without `--dry-run` to write `DENY_HASHES.json`.

Never paste a real pattern into a document, issue or commit message. The pattern files are private and are read only by the gates.

The permission rules need no filling in. They ship in `settings.system.json`, and your own additions go in `LIFEOS/USER/CONFIG/settings.user.json`. `settings.json` is rebuilt from those two at session start, so never edit it directly.

## Accounts and secrets

None of the lists hold a secret. Three pieces of setup sit around them.

- The hash tool needs a random salt, `DENYLIST_SALT`, in `~/.claude/.env`. The tool creates it the first time you run it for real. Check it exists with `bun LIFEOS/TOOLS/Secrets.ts has DENYLIST_SALT`, which prints `yes` or `no` and never the value.
- The `pre-push` check asks GitHub whether a remote is private, so it needs the GitHub CLI signed in. Run `gh auth login` once.
- If you keep `~/.claude` in git, install the git hooks once with `bun LIFEOS/TOOLS/Secrets.ts install-hook`. It writes `pre-commit` and `pre-push` into each private tree and `commit-msg` into `~/.claude`.

## Prove it works

Run these from `~/.claude`.

```bash
bun LIFEOS/TOOLS/SkillHygieneGate.ts           # exit 0: no skill contains a deny-list hit or a home path
bun -e 'const s = await Bun.file("settings.json").json(); console.log(s.permissions.deny.length, s.env.LIFEOS_SUBAGENT_SANDBOX)'
ls -l .git/hooks/pre-commit .git/hooks/pre-push
bun -e 'import { isOwnedHost } from "./hooks/lib/texting-guard-core.ts"; console.log(isOwnedHost("example.com"))'
```

The second command prints a deny-rule count above zero and `on`, which means the native rules are in place and the subagent sandbox is enabled. The third lists both git hooks once `install-hook` has run. The last prints `false` on a fresh install and `true` after you add `example.com` to `owned-hosts.json`. Swap in your own domain to check your list.

Everything these guards need ships with the release. Nothing here depends on a service outside this tree.
