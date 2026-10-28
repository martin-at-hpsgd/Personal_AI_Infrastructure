---
name: Errata
evals:
  manual:
    reason: "whether a filed complaint carried enough context to investigate later is judged at triage time"
    falsifier: "a triage report cannot name what was requested or what the system was doing for an entry filed through /er"
metadata:
  short-description: "File feedback about LifeOS or one of its apps into the Errata complaint ledger; list recent entries; run enrichment and triage."
version: 1.2.1
description: "Front door to Errata, the complaint ledger: file a complaint, bug, feature request, or praise about LifeOS or one of its apps as one JSONL line with context, list recent entries, or run enrichment and triage now. USE WHEN /er, errata, file feedback, log a complaint, this is broken and I want it recorded, feature request for LifeOS, that answer was wrong log it, review errata, triage errata, what have I complained about. NOT FOR ratings (a bare number is already captured), standing rules (say 'from now on' and the Upgrades store takes it), incident narratives (the incident runbooks), or the Upgrades queue itself (Upgrade)."
---

# Errata

The front door to the complaint ledger. Errata keeps one JSON line per moment a human was unhappy with a system we built, verbatim at capture, enriched later by a model, and triaged into Upgrades records. The hook already catches low ratings, corrections, and frustration; this skill is for the deliberate case: the principal wants something recorded, now, with its context.

## Ideal State

- Every deliberate complaint, bug, feature request or praise the principal files becomes exactly one ledger line holding the principal's own words and enough context to investigate it a month later.
- Nothing in the ledger is invented at capture: no paraphrase, no estimated rating, no summary or tag the principal did not give, and no standing rule filed here as well as in the Upgrades store.
- Review and triage work from the same live ledger the hook and the daily job write, so what the principal reads back and what becomes an Upgrades record is one set.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Record** | `/er <text>`, "file this", "log a complaint", "feature request:" | `Intents/Record.md` |
| **Review** | `/er review`, "what have I complained about", "recent errata" | `Intents/Review.md` |
| **Triage** | `/er triage`, "triage errata", "enrich the errata" | `Intents/Triage.md` |
| **Send** | "feedback, send feedback upstream, report this to LifeOS, file an issue on LifeOS, /feedback" | `Intents/Send.md` |

### References

| File | Read when |
|---|---|
| `Setup.md` | first-time setup: the GitHub CLI login the Send intent needs, the ledger paths, and a read-only proof |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Errata/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md, configurations and resources override the defaults here; when it is absent, the defaults stand.

The ledger lives at `<configRoot>/LIFEOS/USER/ERRATA/` (override: `ERRATA_DIR`); attachments at `~/.local/state/lifeos/errata/` (override: `ERRATA_STATE_DIR`). Schema and store: `LIFEOS/ERRATA/Schema.ts`, `LIFEOS/ERRATA/Store.ts`. System doc: `LIFEOS/DOCUMENTATION/Errata/ErrataSystem.md`.

First-time setup: [Setup.md](Setup.md).

## Gotchas

- **Capture is verbatim because nothing can regenerate it.** The no-paraphrase and no-estimated-rating rules in Record exist because an earlier failure log let machine-filled ratings in, and those fabricated values poisoned every analysis built on it (2026-09-17 design decision). The schema validator refuses a machine source that carries a `rating`.

## Examples

```
/er the deploy said live but the page still 404s
/er bug: /socrates renders the stale banner even after a fresh tick
/er feature: let me rate a response from the phone
/er praise: the triage report named the fix before I asked
/er --product the installer assumes zsh
/er review
/er triage
```
