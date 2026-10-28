---
version: 1.1.4
---

# Socrates — the standing-question ledger

> The system that stops the principal being surprised. It holds every standing
> question worth asking about a life and an estate — security, money,
> ownership, operations, health — and answers each one on a schedule from
> deterministic sources that already exist. Every answer is three-valued:
> pass, fail, or unknown, and unknown is shown as loudly as fail. A question
> nothing can answer yet stays in the ledger as `unanswerable`, because a named
> blind spot is worth more than a forgotten one.
> ISA (state of record): `LIFEOS/SOCRATES/ISA.md` (maintainer-side; the ISA does not ship). Design of record: the
> maintainer's private design notes (2026-08-26), summarized in this document.

**Alerting:** Socrates results are emitted into Vigil (`../Vigil/VigilSystem.md`); its direct security email continues until Vigil ISA ISC-144 moves it (Vigil has run in `decider_mode` enforce since 2026-10-08, and `Router.ts` here still sends the security email).

## The loop

```
questions (USER data)        answers (text store)              action + surfaces
─────────────────────        ────────────────────              ─────────────────
LIFEOS/USER/SOCRATES/   ┐                                   ┌→ Pulse /socrates board
  questions/*.json      ├→ hourly tick ─→ adapters ───→ ────┤→ findings journal (USER repo)
                        ┘   (launchd,       pass|fail|      ├→ Achilles entry + work-repo ticket
                             headless)      unknown          └→ email (security domain only)
                                                 ↑
                              a persisting fail routes; a same-question pass closes
```

A question is an STP whose closer reads. The registry never writes ideal
state and never stores a secret; adapters never build a new probe — each one
reads the output of an engine that already runs (the infra scanner, Bunker,
Atlas, Achilles, launchd, the finance tooling). Socrates federates them behind
one ledger, one answer store, one board.

## Components

| Piece | Path | Job |
|---|---|---|
| Engine CLI | `LIFEOS/SOCRATES/Socrates.ts` | `tick` · `route [--dry-run]` · `sync <adapter>` · `list` · `show` · `board` · `findings` · `validate` · `export` · `rebuild` · `seed` |
| Registry | `LIFEOS/SOCRATES/Registry.ts` | loads `LIFEOS/USER/SOCRATES/questions/*.json`; invariants refuse malformed rows, duplicate ids, credential-shaped strings. Ships with zero real questions; `seeds/template.json` is the generic starter |
| Store | `LIFEOS/SOCRATES/Store.ts` | plain-text answer store under `~/.local/state/lifeos/socrates/` (outside both repos): `runs.jsonl` + monthly `answers-YYYY-MM.jsonl` are truth, `latest.json` is the derived fold (tmp+rename), `snapshot.json` is the redacted Pulse read surface. One writer at a time via an mkdir lock |
| Findings journal | `LIFEOS/USER/SOCRATES/findings.jsonl` | append-only `open` / `resolve` / `route` events, inside the USER git repo so history is the audit trail |
| Adapters | `LIFEOS/SOCRATES/adapters/` | `workflows-scanner` · `atlas` · `achilles` · `ownership` · `finance` · `services` · `launchd-path` (per LaunchAgent, every command the entry script spawns resolves on the plist's own PATH; fails only for a name that exists on the login PATH and not the plist's, the exit-127-under-launchd class) · `backups` (the nightly backup log closing banner + the newest offsite manifest under 48h; the restore drill stays `untouched`, 2026-09-15) · `bunker` · `secrets` · `state` · `ulwork` · `evals` (judged eval suites running without an earned calibration record, from `EvalCensus.ts`) · `router` (off-carrier rate of heavy sessions, from `RouteAudit.ts`) · `vigil` (is the Vigil tick alive) · `telos-risks` (the TELOS risk register: overdue reviews, unwatched risks, broken links; see Relationship to neighbours) · `threatmodel` (risk-register health: overdue reviews, unowned High/Critical, data stores newer than the sensitive-data map — the register-as-questions loop, 2026-09-04) · `usage` (automatic spend: reads UsageAggregator's nightly `automatic` sub-rollup — sessions the LoadContext hook registered with a non-desktop channel — and passes when the last 7 complete days average under the ref's $/day ceiling; unknown while the rollup is stale or no session has been classified, 2026-09-07) — versioned, contract-tested; an error or missing prerequisite yields `unknown`, never `pass`, never a dropped row |
| Router | `LIFEOS/SOCRATES/Router.ts` | the v1 action slice: a finding that keeps failing becomes an Achilles entry and a work-repo ticket; propose-only, never remediates |
| Scheduled tick | `com.lifeos.socrates` (`InstallSocrates.ts`) | hourly launchd job with `LIFEOS_NOTIFICATION_CHANNEL=headless`: run due adapters, apply answers, route persisting findings, export the snapshot |
| Pulse module | `LIFEOS/PULSE/modules/socrates.ts` | GET `/api/socrates` from the snapshot + registry only (code holds zero data) |
| Pulse page | `Observability/src/app/socrates/page.tsx` | per-domain pass/fail/unknown tiles, open findings with routed pills, the unanswerable panel, a staleness banner when the snapshot is older than 2× the shortest cadence |
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## The question object

One record schema, questions as DATA in the private USER tree. Each row
carries an id (`SOC-0001` shape), a domain (security · financial · infra ·
ownership · operations · health · content · prediction · personal), the
question text, an authored `ideal` in plain language, a status (`active` ·
`unanswerable` · `retired`), a verifier class (deterministic · judged ·
attested), a cadence (hourly · daily · weekly · monthly), a severity, and the
adapter that answers it. A row with no answerer is `unanswerable` by
definition and renders as such.

## Answer contract

- Verdicts are `pass | fail | unknown`. `unknown` never aggregates into pass in any stat, tile, or banner.
- Every answer names `computed_from`: the sources it touched AND the bearing sources it did not.
- Every answer carries the adapter's `closer_version` and a run id, so a verdict is reproducible to its inputs.
- A finding opens on a violating answer and resolves ONLY on a same-question pass — never on an error, never on question deletion. One addition (2026-09-15): a per-instance finding also resolves, reason `instance-gone`, when a COMPLETE run of the same question answers other instances but no longer names this one — a retired launchd job cannot pass again, and without this rule it left a zombie Achilles entry. Incomplete runs and un-instanced questions never trigger it. Known edge: `complete` means every question answered, not every instance enumerated, so a manual `sync services` from a launchctl domain that cannot see the gui jobs would resolve their findings; the scheduled tick runs as a LaunchAgent and is unaffected.
- Secret-shaped strings are refused at every write path; the snapshot is redacted before Pulse reads it.

## Routing (v1)

The router runs inside `tick` after the adapters and before the snapshot
export. A finding routes only after it has failed a cadence-scaled number of
consecutive ticks (hourly 3, daily 2, weekly and monthly 1), at most five per
tick, with a 24-hour re-route cooldown per question instance. `unknown` never
routes. Execution is re-entrant in a fixed leg order — Achilles entry, then
ticket, then journal event, then email (security domain only) — so a crashed
half-run completes on the next tick with no duplicates. When a routed finding
later passes, its Achilles entry closes once with honest evidence ("condition
cleared"), which closes the ticket in Achilles' same motion. Achilles stays
the registry of record; Socrates feeds it.

## Anti-doctrine

Socrates never writes TELOS or ideal-state files. It never stores a secret
value. It never builds a probe an existing engine already runs. Scheduled runs
never voice-notify (headless channel). The router registers and asks; it never
remediates. Local SQLite is not used: the store is text by doctrine
(`LifeosSystemArchitecture.md` § founding principles, AD-1 JSONL for
append-heavy state).

## Relationship to neighbours

- **Achilles** holds concrete weaknesses with a lifecycle; Socrates asks the standing questions whose failures become Achilles entries.
- **Atlas** is current state of everything owned; the `atlas` adapter reads its redacted snapshot.
- **Bunker** is the application harness; the `bunker` adapter reads its site-health status.
- **ThreatModel** holds standing estate risks; a question may carry a `risk_ref` that Achilles receives on routing.
- **TELOS** is the ideal-state side; Socrates only ever reads. Its `## Risks (RN)` section is the principal's life risk register (the ten scenarios that could take them off their path, each with prevent/detect/respond state), and the `telos-risks` adapter watches it the way `threatmodel` watches the estate register: `overdue-review`, `unwatched` (detect `none` or `unknown` and no link to an active question), `broken-links` (a link token that no longer resolves). Parser: `LIFEOS/TOOLS/TelosRisks.ts`.
