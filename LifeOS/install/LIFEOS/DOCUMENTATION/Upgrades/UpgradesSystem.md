---
last_updated: 2026-10-01T21:13:14.017Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.1.4
---

# The Upgrades System

> **Private component — parts of the tooling described here are NOT in the public release payload.** Intents that route through the underscore-prefixed release-management skill are rsync-excluded from public releases, so those commands will not resolve on a fresh public install.

> **One queue for every system-improvement candidate, from every source, with one lifecycle — the pending half of the change pipeline. The Ledger is the applied half.**

> **Review's queue (2026-10-10).** Review (`LIFEOS/REVIEW/`, Pulse `/review`) is the one place for improving LifeOS. This store is Review's queue underneath, with no page of its own: `/upgrades` redirects to `/review`. The Upgrade skill, which finds outside ideas on the internet, is one input to it like every other source.

**In the quality loop** (concept: `../LifeOs/HillClimbing.md`):

- **Owns:** the one queue of system-improvement candidates and its lifecycle.
- **Never does:** applies a change on its own. Acceptance is human, and the Ledger records what was applied.
- **Reads:** producers: directives, upgrade scans, Errata clusters and false passes, and Assay misses.
- **Writes:** upgrade records, and the before and after complaint rate for an applied change that targets one skill.

## Why it exists

Before 2026-07-23, improvement signals lived in six places with no shared schema: corrections in `LEARNING/FAILURES/`, hypotheses in `WISDOM/FRAMES/_hypotheses/`, memory proposals in `pending-proposals.jsonl`, Upgrade-skill recommendations nowhere (ephemeral reports), /algo proposals in per-run REPORT.md files, and applied changes in the Ledger. The middle of the pipeline — proposed → decided → applied — had no home, and standing directives ("from now on X") had no deterministic capture at all.

## The store

`LIFEOS/MEMORY/UPGRADES/` (private, in the USER data repo via the MEMORY symlink):

- `records/<id>.md` — one record per candidate: frontmatter (`id`, `status`, `source`, `created`, `expires`, `confidence`, `target_surface`, `session_id`, `ledger_id`, `evidence`) + body (`## Claim`, `## Current State`, `## Recommendation`, `## Notes` history).
- `.state.json` — claim-hash dedup sidecar (same normalized-claim hashing pattern as the hypotheses deriver).

Tool: `LIFEOS/TOOLS/Upgrades.ts` — `add | list | show | accept | reject | apply | verify | expire | stale | stats` (`stale` lists recommended records older than 14 days). Exported functions (`addUpgrade`, `listUpgrades`, `setStatus`, …) are imported directly by the hook and the Pulse module.

## Lifecycle

`recommended → accepted → applied → verified`, or `rejected` / `expired` (30-day TTL, swept opportunistically on each Pulse API read). Illegal transitions are refused by the tool.

## Sources (producers)

> **Note:** Private maintenance intents are absent from the public release; those paths and tools do not exist on an installation.

| Source | Producer | When |
|---|---|---|
| `directive` | `SatisfactionCapture.hook.ts` standing-directive leg | The turn the principal says "from now on / in the future / always X / never X / new rule / <DA name> should always…" — deterministic phrase match (the DA name is read from the DA identity at run time), no LLM |
| `correction` | No longer written as of 2026-08-06 (was: same hook, correction leg) | The dual-write is gone because it filled the store with raw complaint text that nothing read. Corrections still write the FAILURES incident, and /algo turns that corpus into `algo-run` records with drafted recommendations. Historical `correction` records stay on disk, expired in place, and still parse. The memory reviewer still files one when a proposed edit to an always-loaded file is not global in scope and belongs in a skill or project file |
| `upgrade-skill` | `skills/Upgrade` Intents (persist step) | Every 🔴/🟠/🟡 recommendation of a scan run |
| `algo-run` | Private maintenance workflow (not included) | Every ranked proposal of an /algo pass |
| `autonomous` | Nightly deriver (`LearningPatternSynthesis.ts --hypothesize`) | Unchanged — still writes `WISDOM/FRAMES/_hypotheses/`; the Pulse layer maps pending hypotheses into the queue as `source=autonomous`, and accept/reject proxy to graduate/reject (PromoteFixture flow intact where the maintainer-side promoter is installed). `KnowledgeDistill.ts` system-lane items and `IntegrityFindings.ts` also file under this source |
| `assay-miss` | Errata triage, from the miss loop | A false pass (a receipt passed, the principal caught a defect) or a cluster of complaints about one skill, proposed as one concrete standing check for that skill. Once applied, the skill's complaint rate before and after is reported. Filed by `Errata.ts misses --file-upgrades` and `FalsePassDraft.ts`, one record per false pass, deduped by output id |
| `hillclimb` | `skills/HillClimb/Tools/HillClimb.ts close` | One record per closed climb, naming the climb id, the baseline and best values, and the kept changes. The same tool's `verify` moves the record to `verified` only when Errata shows the target skill's complaint rate fell |
| `coach` | `CoachReview.ts` | Daily: a recommendation that the DA change a behavior, mined from the principal's corrections, carrying the correction verbatim and a category |
| `errata` | Errata triage and recommend (`ERRATA/Triage.ts`, `Recommend.ts`) | A cluster of complaints filed as one record, linked back to the Errata entries |
| `evidence` | `EVIDENCE/Recommend.ts` | A routed-versus-held-out comparison whose 95% interval excludes zero |
| `review` | Review (`REVIEW/Review.ts decide`) | The principal's yes on a Review recommendation |
| `analysis` | The maintainer-side analysis shortcut (not in the public release) | Each ranked change from an analysis of LifeOS itself |
| `manual` | `Upgrades.ts add` | Ad-hoc |

## Ledger integration

The Ledger (`MEMORY/SYSTEMUPDATES/`) stays constitutively applied-only. The link: `LIFEOS/TOOLS/CreateUpdate.ts --upgrade-id <id>` (or `upgrade_id` in stdin JSON) stamps `upgrade_id` into the ledger entry's frontmatter AND marks the upgrade record `applied` with `ledger_id` pointing back. Pulse `/review` shows the join in its applied list.

## Pulse surface

The page is `/review`: `/upgrades` folded into it on 2026-10-10 and now redirects there, as `/hypotheses` did earlier. `/review` lists the queue (pending and accepted, source-badged) and every applied change with its ledger id. The API is unchanged: module `LIFEOS/PULSE/modules/upgrades.ts`, routes `GET /api/upgrades`, `GET/POST /api/upgrades/:id[/accept|/reject]`. Hypothesis-backed items carry `hyp:<slug>` ids.

## Boundaries

- **Synapse** captures content ideas, not system changes (its `tech_upgrade` route may forward here later — not yet wired).
- **Memory Tier-C proposals** about identity/contacts/style stay in the Memory lane; facts about the principal are memory, changes to how the system works are Upgrades.
- The store never auto-applies anything; acceptance is human (Pulse buttons) or the principal's explicit instruction in-session.

## Related

- **Concept:** `../LifeOs/HillClimbing.md` § 7 (Upgrades is the action queue).
- **Feeds me:** the HillClimb skill (closed climbs, and the before/after verify); `../Errata/ErrataSystem.md` (clusters and false passes); `../Assay/AssaySystem.md` (the `assay-miss` source, a miss turned into a standing check).
- **I feed:** `../Assay/AssaySystem.md` (new standing checks); `../ISA/ISASystem.md` (sharper criteria); `../Ledger/LedgerSystem.md` (applied changes).
- **ISA:** the Assay-everywhere ISA covers the loop (maintainer-side; does not ship); the queue's own criteria live with its code.
