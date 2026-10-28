---
version: 1.0.1
---

# Achilles

Status: `bun LIFEOS/TOOLS/Achilles.ts stats` · optional

## What it does

Achilles is the one place LifeOS keeps every known weakness in what you run: an outdated router, an expiring certificate, a leaked key, a risky vendor. Each entry has a category, a severity, evidence, and a life cycle that ends only when someone records proof that it is fixed. Pulse shows the open entries on its `/achilles` page, and a red strip appears on every Pulse page while a critical or high entry is open.

Findings arrive from several sources: the security-news match against your stack, the infrastructure scanner, the threat model, and entries you add by hand. The stack manifest lists the technologies you run, so a news story about a product you own becomes an entry and one about a product you don't stays informational.

Each entry also gets a fix class: `auto` (the system closes it on evidence, such as a patched browser), `agent` (a worker can prepare a tested patch), or `human` (a decision, a credential, or live infrastructure is needed). Standing risks live in the threat-model register, and Achilles holds the concrete cases.

You can skip all of this. With no registry the page is empty and nothing else in LifeOS depends on it.

## Fill in

Everything lives in `LIFEOS/USER/SECURITY/ACHILLES/`. The registry itself is created by the tool; you never write it by hand.

| File | What it holds |
|---|---|
| `stack.json` | `{ "generated_at", "sources", "terms" }`. The product and vendor names you run. Ships empty; fill it with `bun LIFEOS/TOOLS/Achilles.ts gen-stack`, which reads your Atlas snapshot and `GEAR.md` and adds a built-in list of common platform names. You can edit `terms` by hand, but the next `gen-stack` rewrites the file. |
| `risk-map.json` | `{ "rules": [] }`. Links a kind of finding to a risk in your threat-model register. It does nothing until you ratify it: add `ratified_by` (your name) and `ratified_at` (a date) at the top level, then rules such as `{ "source": "manual", "risk_ref": "R-001" }`. |
| `fix-classes.json` | Optional. Overrides the built-in fix-class guess, for example `{ "manual|": "human" }`. Keys starting with `_` are ignored. |

Create the threat-model register the risk map points at, then add a first risk:

```bash
bun skills/ThreatModel/Tools/RiskRegister.ts init
bun skills/ThreatModel/Tools/RiskRegister.ts add --title "<what could go wrong>" --threat "<how>" --likelihood 3 --impact 3
```

File your first entry by hand, then close it with evidence:

```bash
bun LIFEOS/TOOLS/Achilles.ts add --title "<short description>" --category technical --severity medium --source manual
bun LIFEOS/TOOLS/Achilles.ts close <ACH-id> --evidence "<how you know it is fixed>"
```

Categories are technical, financial, reputational, legal, physical and operational. Severities are critical, high, medium and low. Never put a key, token or password in an entry. The registry refuses text that looks like a credential.

## Accounts and secrets

The registry, the Pulse page and `stats` need no account and no key. These extras are optional and each needs its own setup:

- `ticket <id>` opens an issue in your private work repository, and `close` closes it. Both need the GitHub CLI signed in (`gh auth login`) and a work repository set up as in `LIFEOS/DOCUMENTATION/Setup/Work.md`. A repository that is not confirmed private is refused.
- The daily remediation email needs your mail account, covered in the Google guide.
- The nightly patch worker needs an OpenAI login for Codex. It only ever proposes a tested patch to your own LifeOS install and never deploys or pushes.

The Synapse news match and the maintainer's private vulnerability-management skill are part of the maintainer's own workflow tree and are not in this release (see Prove it works). They add entries to the same registry, but you don't need them for it to work.

## Prove it works

Run these from `~/.claude`.

```bash
bun LIFEOS/TOOLS/Achilles.ts stats   # prints counts as JSON, exit 0; all zeros on a fresh install
bun LIFEOS/TOOLS/Achilles.ts list    # one line per entry, ending in "N entries"
```

After you add the example entry above, `stats` shows `"total":1` and the entry appears in `list` and on the Pulse `/achilles` page. A `status` command does not exist: `bun LIFEOS/TOOLS/Achilles.ts status` only prints the list of valid commands.

Two parts of the finder side are not in this release. The Synapse leg that matches security news to your stack lives in the Workflows worker tree, and the vulnerability-management skill that feeds it is private. You can still file entries by hand with `add`.
