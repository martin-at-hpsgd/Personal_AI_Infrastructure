---
version: 1.3.4
---

# Errata — the complaint ledger

> Every moment a human was unhappy with a system we built, or a system caught
> itself failing a human, becomes one JSON line: who said it, about which
> system, what they had asked for, what the system was doing, what it
> answered, how upset they were, and what part they were upset about. The
> line is preserved verbatim first and enriched later through the low OpenAI
> lane, so a future analysis can re-read this year's
> errata and find what today's analysis missed. A daily process enriches, labels and
> triages them into a report, and the v4 pass files recommendations to Upgrades. Errata is the evidence; its recommendations live in Review, which decides with the principal what to change (`LIFEOS/REVIEW/`, Pulse `/review`).

**In the quality loop** (concept: `../LifeOs/HillClimbing.md`):

- **Owns:** the complaint ledger: one verbatim line per moment a human was unhappy, then its enrichment and triage.
- **Never does:** stores anything but complaints, calls a model while the principal types, or acts on its own findings. Upgrades is the action queue.
- **Reads:** everything, by joining: the output ledger, Assay receipts and the run lines. A complaint carries `context.output_ids` (the outputs delivered since the previous typed prompt; with no prompt time and no turn on the session's output lines, the session's outputs from the last 30 minutes, at most 20), so it resolves to output, receipt, run and skill.
- **Writes:** the erratum line and its enrichment. It reports per-skill complaint rates over outputs delivered, false passes (a receipt passed and the principal still caught a defect, counted only when the complaint cites a single output) and misses, and files clusters and false passes to Upgrades.

**Criteria live in the subsystem ISA beside the code.** This doc explains.

Its taxonomies and audit questions are designed backward from the LifeOS changes their answers will drive (2026-09-19).

## What it is not

Not a log of everything that happens: Errata stores complaints only, and sees
everything by joining them to the output ledger and receipts (EventLogger and the
reflections corpus keep the general record). Not a second Upgrades store. Not a per-turn sentiment classifier in the
hook path: nothing in Errata calls a model while you are typing. Not a
dashboard before the data exists.

## The unit

One erratum. Schema: `LIFEOS/ERRATA/Schema.ts`. The load-bearing fields:

| field | meaning |
|---|---|
| `system` | `lifeos` · `other`, plus any names in `LIFEOS/USER/CONFIG/errata-systems.json` |
| `instance` | which install or tenant it came from (a hostname hash for LifeOS, a tenant id for an app) |
| `target` | `instance` (this install) or `lifeos-product` (feedback for the LifeOS project itself) |
| `source` / `channel` | who reported (principal, team, customer, user, hook, agent, job, backfill, detected) and through what door; `detected` is a miss inferred from how the next prompt reacted (`LIFEOS/EVIDENCE/Trigger.ts`), machine-written and never a complaint-rate input |
| `kind` | complaint · bug · feature-request · correction · praise · question · incident |
| `rating` | a number the human actually gave; never inferred, null otherwise |
| `frustration` | 0–3 from countable signals at capture (profanity, caps, repeat markers); null when not computed |
| `complaint` | the verbatim words, secrets redacted |
| `context` | `requested` (the ask in flight), `doing` (last tool calls), `response_preview` + `response_hash`, `session_id`, `isa`, `component`, `cwd`, `version`, `model` |
| `reporter` | stable id + role; customers are never an email in the clear |
| `enrichment` | null until a model fills it: `how_upset`, `which_part`, `what_upset`, `reporter_right` (+ reason), `root_cause_hypothesis`, `class`, `proposed_fix`, `confidence`, plus `model` and `enrichment_version` |
| `status` / `links` | new → enriched → triaged / upgrade-filed → fixed / wontfix / duplicate; links to the upgrade, incident, issue, commit, FAILURES dir |

Entry enrichment lives inside `enrichment`; audit judgments and fix proposals are stored separately in `labels-v3.jsonl` and `proposals-v3.jsonl`. The validator refuses a machine
source carrying a rating and an enrichment no model wrote. That is the lesson
from the FAILURES corpus, where a fabricated `rating: 3` on every correction
poisoned the analysis built on it.

## The store

Plain JSONL, no database. `LIFEOS/USER/ERRATA/errata-YYYY-MM.jsonl` inside the
USER repo (a few lines a day, versioned with everything else about you).
Rotation is the month boundary plus `errata rotate --before YYYY-MM`, which
gzips older months into `archive/` after verifying the round-trip; archived
months are still read. Large attachments go to `~/.local/state/lifeos/errata/<id>/`
outside git. Nothing is rewritten in place: an update is a `patch` line that
folds onto the erratum by id at read time, so the log stays the truth and a
torn trailing line is skipped, never fatal.

Every erratum the store appends, and every patch that sets a status or an enrichment, also writes one row on the STATVS `errata` stream (`LIFEOS/STATVS/lib/quality.ts`): the id, kind, system, the status after the change, and the session and output ids. The row never carries the complaint, the context text or the enrichment prose. The ledger keeps writing as before and stays the store every Errata reader uses. Only the real ledger mirrors to the live record; a fixture or scratch ledger mirrors only into a scratch record, and a record fault is logged, never thrown. This is step 1 of the five-step STATVS migration.

## The doors

- **The hook.** `hooks/SatisfactionCapture.hook.ts` writes every explicit
  numeric rating, praise signal, explicit correction, and standing directive
  to this ledger via `LIFEOS/ERRATA/Capture.ts`. Numeric ratings become one row
  with `kind: praise` at ≥7 and `kind: complaint` below; praise has
  `rating: null`. A rating ≤3 or explicit correction may add a deep-context
  `FAILURES/` attachment linked as `links.failure_dir`, and a standing directive
  may link its downstream Upgrades record as `links.upgrade_id`. Implicit
  sentiment inference remains removed.
- **`/er <text>`.** Deliberate feedback from the terminal. A leading tag picks
  the kind (`bug:`, `feature:`, `praise:`; default complaint); `--product`
  marks it as feedback about the LifeOS project rather than this install.
  `/er review` lists recent entries; `/er triage` runs triage now. Skill: `skills/Errata`.
- **The feedback command (a maintainer-side shortcut, not in the public release; the Errata skill's Send intent is the capability).** Feedback about the LifeOS project itself. It records an erratum with `target: lifeos-product` on the `feedback-command` channel, then, only after the principal's yes on the exact text, files a scrubbed GitHub issue under their own `gh` login (the Errata skill's Send intent).
- **Backfill.** `errata backfill` imports the older signal stores
  (`ratings.jsonl`, retired 2026-09-20 and replaced by Errata, low rows; every
  FAILURES `sentiment.json`; every correction-sourced Upgrades record) idempotently.
- **Mining.** `errata mine` sweeps session transcripts under `~/.claude/projects/` with the same deterministic frustration and correction classifier as the hook, no model, resumable; the daily run does it first.
- **Apps.** Production apps can implement the intake contract in `ErrataIntake.md`. The pull command (`errata sync`) is not built: `Errata.ts` has no `sync` command at this head, and no app is wired in (M2-M4).

## Reading it back

`errata daily` (the `errata-daily` workflow, run as the errata step of `delta-daily`; unattended on the OpenAI low lane, never the Anthropic subscription) runs these stages in order, each fault-isolated: mine, enrich, label (audit labels into `audit/labels-v3.jsonl`), triage, report (described below), then the v4 pass. With `--json` (how the `errata-daily` and `errata-weekly` workflow steps call it) stdout is one `{ok, failed, stages}` value instead of one line per stage. The two that shape the ledger:

1. **Enrich** a bounded daily batch of eligible entries whose `enrichment` is null, newest first. The run stops at 150 entries or ten minutes, excludes unauthorized tenant sources, and validates each model reply against the schema; a malformed reply leaves the entry null.
2. **Triage** groups enriched entries by system and class and writes
   `LIFEOS/USER/ERRATA/reports/triage-YYYY-MM-DD.md`, which opens with `references: historical` frontmatter (it quotes paths as they stood that day, so the reference check skips it by that marker; `bun LIFEOS/ERRATA/Triage.ts --mark-reports` adds the marker to older reports). The daily run passes
   `file: false`, so it closes every entry as `triaged` and files nothing; the
   schedule never passes `--file` to v4 either. A manual `errata triage`
   (`/er triage`) still files one Upgrades record (`source: errata`) per cluster
   with two or more entries or any entry at `how_upset` 3, sets
   `links.upgrade_id` and `status: upgrade-filed`, and Upgrades dedupes by claim
   hash, so a re-run files nothing twice. `errata misses --file-upgrades` (the
   `errata-misses-daily` workflow) files one item per Assay false pass. A false pass is a complaint that cites exactly one output whose receipt passed; a complaint citing several outputs (everything the turn delivered) does not say which one it is about, so it names none.
3. **Report** (`Report.ts`, `errata report [--json --dry-run]`, the daily run's report stage) is Errata's own state, told once a day. It counts the last seven days of entries by system and kind (inferred `detected` rows never count) and the entries still in `new` or `enriched` after 48 hours that the daily run should have moved (backfill, detected and tenant rows are not part of that pipeline). It emits one roll-up event to Vigil, medium while any entry is stuck and low otherwise, and one high event the first day an applied or verified assay-miss fix is seen to have raised its skill's complaint rate. The same counts go to `state.json` in the state directory, the file the Current State region reads. Only counts and ids leave the module, never entry text. `--dry-run` computes the state and the events and writes and emits nothing.

## v4: every exchange, many small questions (shadow)

v3 asks the judgment layer one 14-way `failure_class` choice per erratum, so it only sees what the regex capture already caught. v4 reads every prompt the principal typed and asks small yes/no questions that code composes, the way the router was rebuilt (ISA F6).

1. `errata exchanges` streams the session transcripts and keeps each typed prompt (the router's `typedText` filter) with the end of the reply before it, the ask before that, and the last three tool calls. Each row records whether the ledger already holds an erratum for that turn (`captured`: same session, same text or within 30 s and before the next prompt). A rerun appends nothing.
2. `LIFEOS/ERRATA/Questions.ts` holds only nouls in four groups: detect (is the principal reacting to something that went wrong), blame (the assistant, the outside world, a change of mind, LifeOS machinery), mode (fifteen failure kinds, several may be true) and cost (lost time, a risky action, blocked). Pure composers turn the answers and the registry cuts into is_failure, defect, a primary class in v3's 14 values, secondary classes, and severity 0–3, or null when an answer is missing.
3. `errata v4 detect` asks detect and blame of every exchange as `judgeMany` pools under the judgment caller `errata-triage` (shadow; `errata-triage` is only the caller name now, since the scheduled job it once shared a name with became the `errata-daily` workflow). `errata v4 diagnose` asks mode and cost only of composed failures. `errata v4 report` splits failures into reported (already in the ledger) and unreported. Answers are stored raw, so a recalibrated cut re-composes without a re-ask.
4. `errata eval sample` draws the gold set (300 exchanges, session-capped, 180 composed failures); `fixtures/LabelBrief.md` is the blind labelers' brief, generated from the bank; `errata eval agreement` reports kappa per question and the 2-of-3 majority; `errata eval score --check` compares v4 with v3's single choice and with the regex, reweighted to the corpus and with session-block intervals.

5. `Combiner.ts` reads the engine's probabilities directly instead of one fixed cut per question: a learned detect head decides who gets diagnosed, and a class head names the class. `ClassTier.ts` puts class on a model judge instead (OpenAI lane through `Inference.ts`, flex tier, answers cached in `v4/classtier.jsonl`), because a noul composition named the labelers' class for too few of the detected failures on gold. Its second look reads the same answer for an exchange the detector passed and flags it when the model names a failure. `ClassTier.ts eval --write` records which level ships and whether the second look is on; Triage4 uses the tier only while the recorded prompt hash matches, else the engine's class stands in.

All v4 data lives under `LIFEOS/USER/ERRATA/v4/`. A v4 run never writes the ledger or `audit/labels-v3.jsonl`, and the state sent to the judgment layer carries no erratum id, session id or home path. ISC-44 held on a session-disjoint holdout (v4 beats v3 on detection and class), and detection recall on the holdout is high (ISC-56). Class given detection is still under its 80% bar (ISC-53), and both v4 judgment callers stay in shadow.

## v4: from failures to recommendations (M7b, shadow)

The 2026-09-20 audit proposals mostly named rules that already existed, so the first question about a failure is whether a rule already covers it. The answer decides the fix: a covered failure needs the rule enforced, an uncovered one needs a rule written.

1. **Rule index** (`Rules.ts`). Every rule in the system prompt, OPERATIONAL_PREFERENCES (its domain sections are part of that one file since 2026-10-25), the current Algorithm, the DA's Writing Style section and CLAUDE.md's rule sections becomes one unit: a top-level bullet or numbered item, a table row, a paragraph or a fenced chunk. Sources resolve through `SystemContext.ts`. The id is `<source>.<nearest heading slug>.<6-hex content hash>`, so an edit elsewhere never moves it; an edited rule keeps its id when its words overlap a vanished unit of the same source by 60% or more. The index lives at `v4/rules.json`.
2. **Coverage** (`Coverage.ts`). For each diagnosed defect a BM25 retriever picks four candidate rules, weighing the complaint and its failure class over the reply's topic. The judgment layer asks one `rule_covers` noul per pair; one exchange's pairs share a call and every exchange goes in `judgeMany` pools. A covered failure is `enforce_rule`, otherwise `add_rule`; no model text decides it. A failure dated on or before its covering rule's own date broke no rule and is counted apart.
3. **Leaderboard.** The v4 report gains "Most-broken rules": the rule's id and text, count, distinct sessions, severity mix and two exemplar messages, sorted by sessions then count.
4. **Clusters** (`Cluster.ts`). A covered failure's bucket is its rule id and stays whole, since the rule is the cause and enforcing it is the fix. An uncovered one's bucket is class × component, where the component is the hook, skill, tool, subsystem or file named in the complaint, reply or tools. Inside those buckets the judgment layer asks `same_root_cause` of each member's three nearest neighbours and code merges connected pairs.
5. **Recommendations** (`Recommend.ts`). Clusters rank by distinct sessions × (1 + mean severity), and the two fix types rank apart (`--top N` is per fix type), so one large rule bucket cannot crowd out every missing-rule gap. For each top cluster with five or more failures and no open Upgrade already carrying its bucket or rule token, the OpenAI lane (`max`, `flex`) reads five to eight exemplars, the rule text, related Upgrades and the hook catalog, and writes a target, a change and a falsifier. For a covered rule the writer follows `LIFEOS/RULES/SelfHealing.md`: a hook or check only for a checkable artifact property or an irreversible act, otherwise the doctrine change that fixes why the rule loses, otherwise no target. The judgment layer then asks whether it is already done, whether it is more prose for a covered rule, and whether it addresses the exemplars. A doctrine check retrieves the rules nearest the change (the same retriever as coverage) and asks, of them together and of each rule read whole, whether the change re-creates what a rule retired, requires what one forbids, or makes mandatory what one leaves optional. Code drops a recommendation on any failed check; the same questions over SelfHealing's placement rules, and whether the change puts a model call inside a hook, are flags, never drops. Survivors go to `v4/recommendations-<date>.jsonl`, drops with reasons to `recommendations-dropped-<date>.jsonl`. Only `--file` writes to Upgrades (`source: errata`, at least five exchange ids), and records the filing in `v4/filed.jsonl` so the report can show each filed cluster's rate before and after its Upgrade was applied. A `source: errata` Upgrade filed by hand that cites exchange ids gets the same row, in the bucket most of its cited failures fall in (`withHandFiled`); one whose cited ids match no bucketed failure gets none.

All M7b questions run under the shadow judgment caller `errata-coverage` (its own budget, so coverage can never starve daily detection). Its two cuts (`rule_covers`, `same_root_cause`) were calibrated on blind labels from three labelers (`Act.ts calib draw|brief|agreement|calibrate`, ISC-54) before anything could file; `Act.ts recheck` re-runs every current check on a stored list. `errata daily` now ends with a v4 pass (new exchanges, detect, diagnose) and `errata weekly` with the M7b pass (index, coverage, clusters, recommendations without `--file`, report). Both are fault-isolated: a v4 failure is logged and never changes the job's exit code.

## CLI

```
bun LIFEOS/ERRATA/Errata.ts add --system lifeos --source principal --channel terminal --kind bug --complaint "…" --reporter-id principal --reporter-role principal
bun LIFEOS/ERRATA/Errata.ts list [--system --kind --status --since --limit --unenriched] [--json]
bun LIFEOS/ERRATA/Errata.ts show <id> · stats · validate
bun LIFEOS/ERRATA/Errata.ts enrich · triage [--include-backfill] · daily [--limit N --mine-limit N --skip-mine --json] · weekly [--json] · report [--json --dry-run] · backfill · mine [--root DIR --limit-files N --dry-run]
bun LIFEOS/ERRATA/Errata.ts by-model [--since DATE] · skills [--since DATE] · misses [--file-upgrades] · impact --skill <Name> --since DATE [--days N] | impact --landed
bun LIFEOS/ERRATA/Errata.ts audit label|human|propose|report|calibrate-labels|calibrate|status
bun LIFEOS/ERRATA/Errata.ts rotate --before YYYY-MM
bun LIFEOS/ERRATA/Errata.ts exchanges [--full] · v4 detect|diagnose [--limit N] [--dry-run] · v4 report
bun LIFEOS/ERRATA/Errata.ts v4 rules build|show <id>|search <text> · v4 cover [--limit N] [--dry-run] · v4 cluster [--dry-run]
bun LIFEOS/ERRATA/Errata.ts v4 recommend [--top N] [--file] [--dry-run] · v4 act [--top N] [--file]
bun LIFEOS/ERRATA/Errata.ts eval sample|brief|agreement|score [--check]
```

Paths are overridable with `ERRATA_DIR`, `ERRATA_STATE_DIR` and `ERRATA_V4_DIR`; tests always use a temp dir. Only the default ledger keeps its run state (`state.json`, the transcript sweep's cursor) in `ERRATA_STATE_DIR`; any other ledger keeps it in a `.state` directory inside its own directory (`stateDirFor` in `Store.ts`), so a run over a scratch ledger never rewrites the real run state.

## Milestones

M1 LifeOS (this doc) · M2–M4 production app integrations · M5 historical
transcript mining · a Pulse page after a month of real data.

## Related

- **Concept:** `../LifeOs/HillClimbing.md` § 6 (Errata is the pain signal) and § 8 (the miss loop).
- **Feeds me:** `../Assay/Records.md` (output lines and receipts, joined through `output_ids`); the principal's reactions as labels.
- **I feed:** the HillClimb skill (`skills/HillClimb/`): its Survey ranks hills from `skills`, `misses` and the v4 most-broken rules, and its Verify reads `impact` to decide whether a climb made complaints fall; `../Upgrades/UpgradesSystem.md` (clusters, false passes and misses); `../Assay/AssaySystem.md` (labels on receipts); `../Vigil/VigilSystem.md` (skills with outputs and no receipts).
- **ISA:** `LIFEOS/ERRATA/ISA.md` (maintainer-side; does not ship).
