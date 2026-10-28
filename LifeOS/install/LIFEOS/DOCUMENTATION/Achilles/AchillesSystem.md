---
version: 1.3.9
---

# Achilles — the vulnerability management system

> The system that knows where the heels are. One registry of record for every
> known weakness across the estate — any category, any finder — with a
> lifecycle from found to closed-with-evidence. Standing risks live in the
> ThreatModel risk register; Achilles holds the concrete instances.
> ISA (state of record): `LIFEOS/ACHILLES/ISA.md` (maintainer-side; the ISA does not ship).

## The loop

Progressive verification stays with each finder and its owning ISA. Frequent critical checks are deterministic, token-free asserts; deeper semantic investigation runs on explicit build or scheduled integrity lanes, after prerequisites. Achilles consumes findings and evidence through existing integrations, never reruns judges during synchronization, and never treats a tournament winner or unavailable verifier as remediation evidence. Uptime remains Bunker's plane. The shared contract is `skills/Assay/References/Progressive.md`.

```
finders                    registry                     surfaces
───────                    ────────                     ────────
Synapse story match   ┐                            ┌→ Pulse /achilles page
Pentest verified PoC   ┤                            ├→ Pulse red banner — the ONE security strip
Workflows infra scan  ├→  Achilles.ts add  →  ────┤→ work-repo ticket (label: security)
Socrates persisting   ┤   registry.json           ├→ email (new security work)
ThreatModel review    ┤                            └→ daily remediation ping (09:00)
a private vulnerability-management skill, if installed  ┤
manual                ┘
                       close ←── evidence required; closes the work-repo ticket in the same motion
```

Achilles is the only place vulnerabilities are managed or reported. Pulse has
exactly one security strip and it reads the registry; no finder wears its own
banner (the scanner did until 2026-09-07 — ISA Decisions).

## Components

| Piece | Path | Job |
|---|---|---|
| Registry | `LIFEOS/USER/SECURITY/ACHILLES/registry.json` | typed entries, git-audited, private |
| CLI | `LIFEOS/TOOLS/Achilles.ts` | add · list · show · update · close · reopen · ticket · sync-scanner · stats · open-crit · gen-stack · classify · apply · backfill-risk · relabel · expire-acceptances · unmapped — every mutation passes invariants; `ticket` opens the work-repo issue and `close` closes it (Achilles owns both ends) |
| Scanner leg | `LIFEOS/TOOLS/AchillesSync.ts` + workflow `achilles-sync` | hourly at :20 (after the scanner's :00 run), headless: mirrors the scanner's findings ledger — persisted findings (3+ consecutive fails, never `availability`) register as `workflows-scanner` entries (entries stored under the scanner's old source name resolve to it through an alias), resolved ones close with the reason mapped, retired-then-back ones reopen; critical/high get a ticket. Read-only toward the scanner. Same run, browser-patch leg (2026-09-15): an open Synapse entry affecting Google Chrome closes as remediated when the installed build (Info.plist) is at or above the highest build number on the story it links — a browser that auto-updates can sit for days already patched |
| Stack manifest | `LIFEOS/USER/SECURITY/ACHILLES/stack.json` | owned-tech terms generated from the Atlas snapshot + GEAR.md (`gen-stack`) |
| Pulse module | `LIFEOS/PULSE/modules/achilles.ts` | GET `/api/achilles` (registry stats and entries, plus the newest security audit's coverage and exposure line), `/api/achilles/banner`, `/api/achilles/report` (the newest security audit report); read-only |
| Pulse page | `Observability/src/app/achilles/page.tsx` | the board: open by severity, history, categories |
| Banner | `Observability/src/components/AchillesBanner.tsx` | red strip on every Pulse page while any critical/high entry is open; clears only by closing the entry |
| Synapse leg | a maintainer-side Workflows worker | called by the amber router on every `security_critical` capture (NOT in the public release payload — the Workflows worker tree is maintainer-side) |
| Remediation ping | `LIFEOS/TOOLS/AchillesPing.ts` + workflow `achilles-ping` | daily 09:00, headless: one email by fix class — patches ready to land, items that need the principal, the nightly queue, what closed itself; silent when nothing is open and nothing auto-closed |
| Fix class | `fix_class` on every entry, stamped at `add` by `classifyFix` (source + shape) plus `USER/SECURITY/ACHILLES/fix-classes.json` overrides; `achilles classify --apply` backfills | **auto** — the system closes it on evidence (a patched browser, a retired job) · **agent** — a worker can prepare a verified patch · **human** — a decision, credential, live infra, or dashboard. work-repo tickets carry `fix:<class>`; `stats` reports open by class and time-to-close (target: under a day for auto and agent) |
| Remediation loop | `LIFEOS/TOOLS/AchillesRemediate.ts` + workflows `achilles-remediate` (nightly 02:30, full pass) and `achilles-urgent` (hourly, critical/high first seen in the last 24h) | picks open entries severity first, then oldest; resolves the repo from a served domain or a project name in `affected` (PROJECTS.md), never guessing; skips duplicates of an older open entry; dispatches a codex worker (Sol, low effort) into a throwaway clone and keeps only a tested diff. A LifeOS-install patch lands on main through `applyPatch` in unattended mode (gate paths, a foreign index, or a blocked or unavailable `Review.ts` refuse it); a project patch is never applied, only offered as a "y" ask. Blocked, needs-repo and false-positive attempts escalate on that pass, two unresolved attempts escalate, and a human-class critical/high escalates with no worker run. Escalations and asks go to the principal as one frozen text per pass (Problem / Pick / Reply: y ACH-NNNN, under 400 chars) via an ordinary high Vigil event, credited as delivered only by a real send of its story key; Vigil re-checks it at send time and holds it if it went stale. Single-flight lock; one Vigil run line per run. Never deploys, pushes, or touches credentials. ISA F7–F9 |
| Apply | `achilles apply <id>` | lands a ready patch on main: `git apply --check`, refuses files with uncommitted work, applies, runs the repo's tests (reverts on red), commits with the worker's co-author trailer. The repo's gated deploy is the principal's next word |
| Security audit | `LIFEOS/TOOLS/SecurityAudit.ts` + workflow `security-audit` (Sundays 06:17) + manifest `LIFEOS/USER/SECURITY/AUDIT/finders.json` | The one front door for a full audit: `run [--dry-run] [--json]`, `start`, `finder <id>`, `report`. The manifest names one finder per Achilles source, each with a mode (`run`, `continuous`, `manual` or `unbuilt`); every mode but `run` is reported as skipped with its reason, so coverage is never overstated. One private report under `USER/SECURITY/AUDITS/` opens on an exposure line, then open findings per estate and life risk, the finders, unanswerable security questions, overdue risk reviews and the change since the last run. It reads the registry, the estate register and TELOS and never writes them; its Vigil events carry counts and ids only. Pulse reads it through `/api/achilles/report` |

## Entry lifecycle

`open` → (`in_progress`) → `remediated | accepted | false_positive` — closing
requires `--evidence` and closes the linked work-repo issue in the same motion.
The closing comment carries the evidence, so it goes only to a repo the
work-config loader has verified private (the same gate as `ticket`). An
unverified or public repo is refused: the local close still stands, and the
JSON result carries `work_issue_close_refused` with the reason.
`informational` is the terminal status for security stories that did NOT match
owned tech: visible on the board, never bannered, never ticketed.

Categories: `technical | financial | reputational | legal | physical |
operational`. Severities: `critical | high | medium | low`. An entry may carry
`risk_ref: R-xxx` linking it to the ThreatModel risk register (validated
against the register at write time). That register row in turn carries
`telos_ref: Rn` — the life-level risk in the principal's TELOS `## Risks (RN)`
section (`LIFEOS/TOOLS/TelosRisks.ts`) — so an entry reads up the chain
ACH → R-xxx → Rn: which of the ten things that could take the principal off
their path this finding is an instance of, and what its prevent/detect/respond
state was when the finding opened. Achilles never points at `Rn` directly; the
estate register is the join.

## The Synapse leg (story → finding)

The amber router's classifier flags `security_critical` (prefilter). The leg
then judges the story against the GENERATED stack manifest with one Inference
call — same vendor AND same product line, never keyword grep — and:

- **matched** → registry entry (open) + work-repo issue (label `security`,
  hidden marker `<!-- achilles:amber:<capture-id> -->` for dedupe) + email.
  Fires on scheduled runs too (does not wait for `--commit-issues`; principal
  directive 2026-08-26). `--dry-run` suppresses everything.
- **unmatched** → registry entry (`informational`). No noise.

Idempotent per capture via `source_ref: amber:<id>`.

## Finder contracts

- **Pentest** (maintainer-side; not in the public release payload): after the PoC gate verifies a finding, register it:
  `bun ~/.claude/LIFEOS/TOOLS/Achilles.ts add --title "<finding>" --category technical --severity <cvss-band> --source pentest --source-ref "pentest:<engagement>:<finding-slug>" --affected "<target>" --evidence "<poc-ref>"`.
  External-target findings (bounty programs) stay in their engagement reports;
  Achilles registers findings against OUR estate.
- **ThreatModel**: a review that surfaces a concrete, actionable weakness
  registers it with `--source threatmodel --risk-ref R-xxx`; the register keeps
  the standing risk, Achilles tracks the instance to closure.
- **Socrates**: the standing-question router registers a finding that has
  persisted past its cadence threshold (`--source socrates --source-ref
  "socrates:<question>|<instance>#<finding>"`), tickets it, and closes the
  entry itself when the question passes again — `LIFEOS/SOCRATES/Router.ts`.
- **Workflows infra scanner**: findings persist to its findings log first
  (first-seen/cleared/alerted); `AchillesSync.ts` mirrors that log hourly
  (`source_ref: workflows:<target|category|check>#<first_seen>`; refs stored with the old prefix resolve to the same entry), so a scanner
  finding IS an Achilles entry once it has persisted. Resolution mapping: pass →
  remediated · tombstoned → accepted (note carried) · not-applicable / retired →
  false_positive. To accept a finding by design, tombstone it in the scanner
  (`POST /findings/resolve {key, note}`); the sync closes the entry as accepted
  on its next pass. The scanner never reads Achilles.
- **Socrates view-questions never register.** A question answered BY the
  scanner or BY Achilles carries `route: "none"`
  in the question pack: it still ticks and shows on the Socrates board, but a
  persisting failure is held, not registered — the concrete findings already
  are entries, and a question answered by Achilles would otherwise feed on its
  own output.
- **Bunker code-sweep**: `bunker code-sweep <app>` (the white-box leg of Bunker's security plane) registers each
  finding it corroborates against the source with `--source codesweep` and a `codesweep:<app>:<hash>` source ref;
  the proposed patch and WAF rule stay held in Bunker's data dir.
- **A private vulnerability-management skill, if installed**: a stack-relevant CVE from its research runs registers
  with `--source vulnmanagement --cve CVE-...`.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## The flowing system (2026-09-15)

Finding and filing were never the gap: entries got tickets within minutes and
then waited on manual remediation. The loop now has a back half, by fix class:

- **auto** closes itself on evidence inside the hourly sync — the browser-patch
  leg, Socrates instance-gone — and shows in the morning email as "closed itself".
- **agent** is worked every night: a worker prepares a patch in a clean clone,
  tests it there, and the morning email lists it as ready. A project patch is
  never applied unattended: one word from the principal ("apply them") lands
  the batch on main, and each repo's gated deploy ships it. The one exception
  is a LifeOS-install patch, which `applyPatch` lands on main unattended after
  its gate-path, index, review and test checks. Nothing else is written to a
  live tree.
- **human** is the real ask: decisions, credentials, dashboards. The email
  says exactly what is needed, and nothing else is hidden in the same list.

The number the loop is measured on is time-to-close per class
(`achilles stats`, Pulse `/api/achilles`): anything auto or agent older than
a day is the system failing, not the principal.

## Anti-doctrine

Achilles never deploys or pushes on its own; the principal's one word ships a
prepared batch. Auto-class closes need tool evidence of the exact condition
(never a wording change); agent-class work only ever lands as a tested patch
through `apply`. The scheduled legs never voice-notify (headless channel). The
registry never stores secrets (write-time invariant). The Workflows scanner stays
the scanner — Achilles tracks, it does not probe.
