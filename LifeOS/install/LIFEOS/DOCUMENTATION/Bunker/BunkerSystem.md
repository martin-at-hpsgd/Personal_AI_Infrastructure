---
last_updated: 2026-10-13T12:00:00.000Z
last_updated_by: da
last_reviewed: 2026-08-09
last_reviewed_by: da
convention: lifeos-freshness-v1
version: 1.10.1
---

# Bunker — the Universal Application Harness

Bunker is the typed chassis every application sits inside. **The app owns the experience** — design, content, domain logic. **Bunker owns the invisible layer** — auth, data, deploy, metrics, health, security. Standardize the pipes, never the paint.

> **Release note:** this document is the concept — the design every LifeOS install builds its own application harness against. The reference implementation (`LIFEOS/PULSE/Bunker/`, CLI `bin/bunker.ts`) is private infrastructure and is NOT in the public release payload. Per-app state lives in the user tree; the Pulse dashboard's `/bunker` page renders whatever apps an install registers.

**In the quality loop** (concept: `../LifeOs/HillClimbing.md`):

- **Owns:** the application harness for deployed apps (registration, cloud probes, monitoring, post-deploy ISA probes), and its row engine, `bunker test`, which executes every Test Strategy row and records one run-ledger line per row. The row engine is a tool Development Test and the deploy probes may call. Assay is the eval system; Bunker does not run it.
- **Never does:** decides what a criterion means, runs a judge inside a liveness or close gate, or counts a shadow answer as a pass.
- **Reads:** the ISA's Test Strategy rows, the judgment layer's `decide()` for `glance` rows, and the label seeds beside the ISA.
- **Writes:** `bunker-runs.jsonl` (the run ledger ISAGate reads at close) and label seeds. A glance row in enforce with a confident no is a fail; in shadow it reports `shadow`, which is neither pass nor fail; an unavailable engine is a skip.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## The idea

Every app needs the same invisible machinery: a database with backups, a deploy path with rollback, health checks, uptime monitoring, auth, secrets handling, security headers, and continuous outside-in security scanning. Building that per-app produces N drifting copies; skipping pieces produces public failures. Bunker builds the layer once — an app declares a **type**, and the type selects which components turn on in each of six planes:

| Plane | Components |
|-------|-----------|
| **Data** | database + migrations, storage/cache, backup/DR, integrity invariants |
| **Control** | app registry, self-registration, type playbook, config, deploy, rollback |
| **Observability** | tracking, health dashboard, test dashboard, logs, uptime, cost-per-app, alerting |
| **Identity** | auth, rbac, user store, audit sink |
| **Security** | secrets, CVE scanning, rate-limit/bot, headers/CSP/TLS, containment |
| **Commerce** *(enterprise)* | payments, customer metrics, billing |

## The harness speaks ISA

An app's `ISA.md` (or `bunker.isa.md`) is one file doing four jobs: the spec, the component manifest, the executable test suite, and the stored current state of the application. The row engine, `bunker test`, reads the ISA's `## Test Strategy` table and runs every probe — a criterion's probe **is** its test case. Development Test calls it to prove the app's criteria pass, and after deploy Bunker's probes run the same rows against the live app. "Add a feature" means adding criteria to the ISA that don't hold yet; between builds, the ISA is the app's state of record.

```bash
bunker test [--isa <path>]   # run every probe in an ISA's ## Test Strategy
bunker test --feature F2[,F3]  # run only the rows of those ## Features blocks (F2 or f2; exit 2 on an unknown feature or a flat ISA)
bunker test --jobs <n>       # run probes concurrently (default 1 = serial); a criterion's stages keep their order and verdicts match a serial run
bunker test --json           # one JSON object on stdout (rows, per-criterion verdicts, summary, dropped, exit); text moves to stderr, exit code unchanged
bunker test --tiers          # the code/glance/judge/human split per ISA and per Feature
BUNKER_LEDGER_PATH=<file>    # sends every ledger write to that file (tests and scratch runs use it to stay off the real ledger)
bunker sync-cloud            # compile adopted apps' probes into the cloud health worker
bunker sync-cloud --check    # drift gate: generated manifest vs ISAs AND the deployed roster vs local (orphan cloud rows)
```

A shell-run row (`bash`, `bun-test`, `bun-property`, `curl`, `screenshot`) whose tool cell is one bare word (`bun`, `rg`) or a constant that always exits 0 (`true`, `:`, `exit 0`, or an `echo` with no pipe, redirect, operator or command substitution) checks nothing, so Bunker reports it as `skip` ("tool cell checks nothing") and its criterion reads unresolved, never pass. A bare `false` still runs, because it can only fail. An unfailable `bun -e` in an ISA's table never runs: the parser drops it as a malformed row, so it is listed under `dropped` and the run exits 1. In a `--skill` run, whose command rows come from skill frontmatter rather than the table, the same `bun -e` reports `skip` like a bare word.

A criterion with a dropped row never reads pass in `--json`, even when its other rows passed, because the dropped row never ran: it reads unresolved, or fail when another of its rows failed.

A manual row whose latest attestation is labelled fail reports as `fail`, not as a missing attestation.

## The row engine and Assay

Assay is the eval system and resolves every criterion's row at the cheapest honest tier. Bunker's row engine (`bunker test`) is the tool that executes those rows for registered apps and hands judged rows to Assay's runners; it is not the eval system's front door.

`suite:<name>` selects the text or image runner from the resolved suite's modality. Image-rubric and meaning-ladder calibration use the actual image pipeline. Pairwise rows can supply `Tournament.ts --calibration <set.yaml>` for criterion-specific preference calibration; missing or stale records remain provisional. Frequent liveness probes disable both shared text inference and the vision judge before provider access.

An ISA's criteria close through three verifier classes (ISAFormat v2.27.0 § *Verifier classes, lanes, and stages*), and since the 2026-08-31 every-ISC-an-assert doctrine `bunker test` executes all three as one row engine. **Deterministic** rows (`bun-test`, `bun-property`, `bash`, `curl`, `screenshot`) run locally; `sync-cloud` compiles the cloud-portable subset into the health worker. **Judged** rows come in three shapes. `eval` rows are dispatched to the Assay skill's `EvalRunner` — the row's tool cell carries `suite:<name>` sugar pointing at the suite that owns trials, calibrated judge config, and negative cases; the verdict line carries pass^k. `pairwise` rows run the Assay skill's `Tournament.ts` (the tool cell is the command): a bracket in code over a pairwise judge, every pair judged twice with the order flipped, a shuffled-seed rerun, exit 0 only on a stable winner; the verdict line carries the tournament summary (winner, pairs, stability, same-family flag). `glance` rows ask Assay's judgment layer one typed question about state that already exists: the tool cell is `glance:<question-file>#<question-id>`, the question file sits beside the ISA under `Questions/`, a bounded producer emits the state as JSON, and the verdict lands in the ledger beside the artifact's sha256 so an unchanged artifact is never re-judged. The verdict follows `decide()`: in enforce, a confident yes is a pass and a confident no is a **fail** (it flips the criterion open, and a close reads that result); an answer under the confidence floor is a skip, advisory only; in shadow the row reports `shadow`, which is neither pass nor fail and cannot close a criterion; an unavailable engine is a skip with its reason. All three shapes share every rule below — integrity lane by default, stage 2, evals-flag gating, the day-cycle cadence, exit 2 as an unavailable verifier — through one `isJudgedType` helper in the parser, so a second judged type can never be deterministic-by-accident on one path. Eval rows are model-priced and default to the deep tier: the monitor runs them at most once per day-cycle (~20h) and carries the last verdict forward between runs so streaks and alerts see a continuous signal. An eval row whose inference calls all fail is an **unavailable verifier**, not a failed criterion (`LIFEOS/RULES/Verification.md`, unavailable-verifier-means-DEFER): EvalRunner exits 2 with `verifier_unavailable: true`, `bunker test` reports the row as `skip` with the reason, and the monitor neither stamps the day-cycle ledger nor erases the row's prior verdict, so an inference outage is retried next cycle instead of reading as a regression or hiding a real one (Bunker ISC-30, 2026-09-03). The first live `eval` row in the system is Bunker's own ISC-29 (`suite:bunker-eval-lane`), a one-case liveness suite that proves the dispatch path end to end. **Attested** rows (`manual`) are the sanctioned rare exception and require a current recorded attestation. Until one exists they report `awaiting-attestation`; after the ISA body changes they report `stale-attestation`; only a matching current record reports `attested`. Awaiting and stale attestations are unresolved evidence, so `bunker test` exits 2. Every manual-only criterion is listed by id so exceptions stay visible. They are the first rung of a ladder, not a class: `bunker attest <isa> <isc> pass|fail --note <why>` records each human verdict as a calibration label in the criterion's seed (`Calibration/seeds/<isa-hash>/<isc>.yaml`, keyed by the ISA's real path so the MEMORY symlink and the direct path share one seed); at ten labels `Calibrate.ts --residue` lists the criterion judge-ready, the seed becomes the judged assert's calibration set, and the manual row retires. A judged row whose suite has no EARNED calibration record (`LabelStore.earnedStatus`: agreement ≥ 85%, two labels per class, nothing stale in the judge chain, rubric, or labels — `LIFEOS/TOOLS/lib/Calibration.ts`) is **provisional**: EvalRunner's report says so with the age in days since the suite's oldest run, `bunker test` prints `PROVISIONAL (Nd: reason)` on the verdict line, the snapshot carries the mark, and Pulse shows an amber pill on the row and the card, red once past 30 days. A provisional pass is still a pass; nothing blocks, and a Socrates standing question asks daily whether any judged suite runs uncalibrated. The assert-coverage gate (`ISAGate` H8) hard-blocks any new ISA closing with a criterion that has no row at all.

**The four-tier ladder.** Every check sits on one of four tiers, ordered by speed and by how much intelligence the verifier needs: `code`, `glance`, `judge`, `human`. Code is a tool that exits zero. The `glance` tier is one typed question to Assay's judgment layer, answered with a probability, far faster than a model judge (the sub-second figure was measured on the engine retired 2026-10-10 and not re-measured; `skills/Assay/References/QuestionDesign.md`). Judge is a model reading an output against anchored levels or a flipped bracket, in seconds to minutes. Human is the principal recognizing the thing on encounter. The tier is derived from the row's `type` and is never authored: the deterministic types give `code`, a `glance` row gives `glance`, `eval` and `pairwise` give `judge`, and `manual` gives `human`. A check sits at the lowest tier that can honestly answer it, and it drifts down the ladder as it earns labels: a human row becomes a `glance` row once the criterion carries labels, and a `glance` row becomes a code row once the question is sharp enough to be a tool. Two guards hold this in place. Only code runs on the blocking path, so no `glance`, `eval`, or `pairwise` row runs on the liveness lane or inside a deploy or close gate, and a judged row never gates a deterministic row of the same criterion. A gate runs no judge, but it reads recorded results: an earned judged row's latest fail keeps the criterion open at close. Every Feature also keeps at least one spanning criterion over the whole artifact at the consumer boundary, and `bunker test --tiers` flags a Feature whose leaves are all `glance` rows as `unspanned`. The `glance` row contract is fixed: type `glance`, a tool cell of the form `glance:<question-file>#<question-id>`, and a JSON question file beside the ISA under `Questions/`. That file carries one typed question and a bounded producer command that emits the structured state to judge. The registry threshold means confidence for every question type, so a noul resolves two-sided and carries a verdict plus the confidence behind it. A row under a shadow caller reports `shadow`, its own status, which counts as neither a pass nor a fail and cannot close a criterion. Every verdict records the sha256 of the artifact it judged, and the call is skipped when the artifact hash, the question, the threshold, and the engine model are all unchanged since the last verdict. Labels that came from a model or from the deterministic layer put the calibration record in the `proxy` state, which never reads earned.

Within its class, the `tier` cell names the row's **lane** (ISAFormat v2.27.0, 2026-09-08) — what it proves, and so how often it may run and what it may spend. **Liveness** rows (alias `fast`; seconds) are the blocking surface: dev loop, deploy gate, close gate, every monitor tick, the cloud worker. They are deterministic by contract — anything checked often is 100% asserts — so the parser drops an `eval` row on this lane with a named reason, and the runner strips every vendor key from a liveness probe's environment and sets `LIFEOS_INFERENCE_DISABLED=liveness`, under which `Inference.ts` exits non-zero: a script that reaches inference from the liveness lane fails instead of quietly costing. **Integrity** rows (alias `deep`; soak, load, full sweeps, judged suites) run on Bunker's clock — the scheduled monitor runs them locally, and the cloud health worker runs the deterministic ones hourly (top-of-hour cycle, last verdict carried forward in between) instead of every 5 minutes. An integrity failure flips the app's Pulse grade and never blocks a ship. It pages only when the row is an uptime or security row on a public app (see What pages, below). An expensive integrity row — a live model ask, a judge suite — carries its own window in the cell (`integrity@6h`, ISAFormat v2.25.0; `deep@6h` still parses): the monitor runs it at most once per window on a per-row ledger and carries its last verdict between runs, so a probe never costs more than the thing it guards. **Build** rows (exemplar comparisons, tournament brackets) run only under `bunker test --deep`; the monitor never runs them and `sync-cloud` never compiles them, so a build row can never page.

A criterion's rows also carry a **stage** (ninth column; default 1 for asserts, 2 for the judged types) and run stage by stage. A judged row never gates a deterministic row of the same criterion, and the parser refuses a `glance` row whose stage does not sit above every deterministic stage of that criterion. A failing lower stage marks every higher row of that criterion `gated` — the row names the assert that failed, is never executed, and never counts as a pass (`healthOf` reports `gated` on its own; Pulse shows a GATED pill). A judge therefore never grades output an assert already rejected, and never spends inference doing so. Every prerequisite needs a pass this run or an unexpired cached pass for its exact row identity. Row identities hash the check content, including its command, threshold, lane, and stage; each row owns its cadence and saved verdict independently of sibling stages. Legacy criterion-keyed timestamps migrate only for unambiguous criteria, and never imply a cached pass. Missing or unavailable prerequisite evidence holds dependent stages; unresolved stages exit 2 in the CLI and cannot advance monitor recovery. A row rescued by the intra-cycle recheck leaves its higher rows held until the next tick. Before any failure counts, the local monitor re-runs a first-time failing probe once, 30 seconds later, in the same sweep (one shared pause per cycle); a pass on that recheck erases the blip, and a failure on a pageable row still has to persist two cycles before one alert fires. Development stays fast because the blocking surface is small; the expensive verification still happens, on Bunker's clock instead of the builder's.

## The two always-on planes

- **Observability plane** — a cloud site-health service compiled from each adopted app's `## Test Strategy` (`bunker sync-cloud` → generated manifest → `/status`). Availability and contract probes run continuously without anyone asking.
- **Security plane** — this IS the infra-security scanner running in the execution layer (Workflows), not a separate system. An hourly outsider scan of the full deployed surface: auth boundaries, exposed secrets, headers/TLS/DNS, CORS, and config checks — the estate as an attacker sees it. Never build a parallel scanner. **Since 2026-09-03 the plane has a second, white-box leg: `bunker code-sweep <app>`.** It ports the seven-stage vulnerability-discovery pipeline Cloudflare published for Managed Defense onto the harness's own seams: a zone traffic snapshot (`LIFEOS/TOOLS/TrafficSnapshot.ts` — top paths, WAF events, Worker invocations, active custom rules; each dataset degrades on its own when a plan gates it) → a route-to-code map (Hono registrations plus entry-file mounts) → one bounded hunt on the Astra lane through `LIFEOS/TOOLS/CodexProgress.ts` (high reasoning, read-only sandbox, the top *N* handler files by exposure = requests + 50 × WAF events) → deterministic corroboration (a finding whose file, line, or verbatim evidence is not in the source is dropped) → registration in the vulnerability registry (Achilles, idempotent by source ref) → held proposals: a unified diff and a WAF custom-rule expression per finding, written to the private Bunker data dir and never applied. Cost is bounded by construction: a monitor tick with unchanged HEAD and a fresh run costs one `git rev-parse`; HEAD moving inside the interval sweeps only the changed handler files; one model call per sweep; errors back off for hours; the heavy run detaches so the five-minute monitor never blocks. An adopted app opts in with a `codeSweep` block in its `bunker.config.ts` and a `deep`-tier Test Strategy row whose criterion is freshness ("the sweep is current for this HEAD") — findings themselves live in the registry, so the harness never double-pages what the registry's banner and daily ping already surface.

## What pages

Bunker is an uptime and security monitor. It pages the principal only when something public is down or insecure, so it can be fixed now. Every other red stays on the dashboard. This is the paging rule of the Bunker ISA (D-12, 2026-10-10).

A page has one of three sources:

- An uptime row on a public app fails, survives the 30-second recheck, and stays failed for two monitor cycles. An uptime row probes the app's own live public host, or carries severity `critical`.
- A public app's Worker keeps crashing. Every app whose deploy config names a Cloudflare Worker gets a built-in crash row in each monitor sweep, with nothing written in its ISA. The row fails when the Worker crashed at least 6 times, in at least 3 different hours, within the last 6 hours (thrown exceptions and exceeded CPU, memory or resource limits; client cancels and Cloudflare's own errors do not count). It is an uptime row, so it pages as not working after two cycles. A Worker can answer its home page with a 200 while a login route or a cron job crashes on every call, and every other row would stay green. The counts come from one read-only analytics query per sweep, `CfEnv.ts workers-crashes`, and `bunker crashes --worker <name>` shows one Worker's count.
- A security row on a public app fails the same way. A security row is tagged security, or asserts an auth boundary (a 401, a 403 or an auth redirect) against the app's live host.
- The security plane finds a high or critical weakness on a public target. Scanner findings register in Achilles once they persist for three hourly runs. A critical texts at registration. A high goes to the digest at registration, and the hourly urgent remediation pass sends the one text when it cannot fix the weakness or needs a decision.

An app is public when its config has a url that is not localhost and it does not set `scope: "internal"`. Internal systems never page, whatever their rows say.

One page is not about an app: the monitor's own dead-man heartbeat (`com.lifeos.bunkermonitor`). The cloud site-health worker pages when that heartbeat is older than its max age, and a slow sweep that is still making progress keeps beating, so it does not page. The `bunker-falsepage` workflow (every 10 minutes) checks each such page against samples of monitor liveness and texts a false page through Vigil.

Everything else is a contract row, and a contract row never pages. Unit tests, file checks, `sync-cloud` drift, evals and judged suites still run on Bunker's clock. They still write the run ledger and still show red in the snapshot and on Pulse. They never send an email or a text. Their reds are worked through Development's Checkup intent and through Assay.

Vigil's Bunker adapter carries the monitor's own decision instead of reading the snapshot's failure count. It emits `high` only when the monitor opens a confirmed alert on a pageable row, `info` when that alert recovers, and `low` for any other red or green flip.

Bunker's probes are anonymous, so they cannot see what a signed-in user waits for. That gap is covered by the user-journey probe and the incident loop (`../Vigil/VigilSystem.md#incidents`): each app's permanent test identities sign in and time the load to real content against a budget, a repeated miss opens an incident, and a confirmed Bunker alert becomes an incident too, so every production problem gets one id across Vigil, Errata and the work repo and stays open until a probe passes after the fix is deployed. A slow load opens an incident without changing the paging rule above: a severe or failed load reaches the principal as a `high` incident event through Vigil.

Asset gaps go to a daily digest. `bunker coverage` reconciles the public hosts the edge serves and the infrastructure inventory against the registered apps and the cloud manifest, in both directions. A scheduled `bunker-coverage` workflow runs it daily and posts one Vigil `medium` event listing every unmonitored public asset. That event lands in the digest and is never a text.

## The registration rule

**Mandatory for every new public deployment, in the same motion as the deploy:**

1. **Observability plane** — an `ISA.md` with a `## Test Strategy`, adopted via `bunker sync-cloud` (the health contract).
2. **Security plane** — added to the scanner's curated target inventory with its real protected paths and data-probe paths, then redeploy the scanner.

Skip either and the app is invisible to the harness — no health contract, or no hourly auth-boundary assertion. There is no "deploy now, register later."

## Where it fits

Bunker is where the ISA System meets running software. The Algorithm climbs toward an ideal state during a build; Bunker holds the app to that ideal state afterward, re-running its probes for as long as the app lives. Pulse renders the result: every registered app's uptime, last security check, and green/orange/red grade on the card face. The display plane is itself under contract: the scheduled monitor writes the snapshot Pulse reads, and a `verify-pulse` probe on the Pulse ISA (plus a Socrates standing question) fails whenever the tab shows fewer apps than the registry discovers or the snapshot goes stale. An HTTP 200 with zero apps is a failure, not a pending state.

## Cross-references

- Master architecture entry: `LIFEOS/DOCUMENTATION/LifeosSystemArchitecture.md` § Pipeline Topology (Bunker row)
- Component map: `LIFEOS/DOCUMENTATION/CoreComponents.md`
- ISA format: `LIFEOS/DOCUMENTATION/ISA/ISAFormat.md`
- Source docs (private implementation tree, not in the release payload): `LIFEOS/PULSE/Bunker/README.md` + `LIFEOS/PULSE/Bunker/ISA.md`

### Labels for a specific question and state

The commands in this section run against the reference implementation, which is private and not in the public release payload.

`bun LIFEOS/PULSE/Bunker/bin/bunker.ts label LIFEOS/PULSE/Bunker/ISA.md ISC-4 --question harness-docs --state LIFEOS/PULSE/Bunker/README.md pass --note "documents the harness and its command" --by "principal"` appends one criterion-seed label. The state file must be within the ISA directory and pass the same producer path restrictions and redaction as a regular glance row. The hash binds JSON serialization of the actual `{claim, artifact}` engine input, including redaction and JSON/text shaping. The label records the question, state hash, note, timestamp, and attester (default `principal`). A `choice` or `score` question also needs `--expected` naming the right option or level; a `noul` question refuses it.

The label command asks the same question through the glance runner, bypasses its cache, and keeps the result in shadow. `--offline` writes only the label; disabled or unavailable inference preserves the label and reports why the observation was skipped. Existing `attest` records the same live-state hash when the criterion has one glance question; manual-only criteria retain a criterion-contract hash without a question binding and cannot join question reports. `attest` refuses a criterion whose glance question is a `choice` or `score`, because that label needs an expected answer; use `label --expected`.

### A judged miss becomes a kept question

When a judgment gets something wrong, `bunker miss <isa> <isc> --kind noul|choice|score --id <id> --question <text> --state <file> pass|fail --note <why>` turns it into a test case in one step. It writes `Questions/<id>.json` beside the ISA, copies the state file byte for byte to `Labels/<id>/state.json` as the kept case, registers the question in shadow under the caller (`bunker-glance` unless `--caller` names another), and appends a label bound to the state's sha256 to the criterion's seed. A `choice` needs `--options a,b,c` and a `score` needs `--criteria low,mid,high`; both need `--expected`. `--producer` points the question at a live producer instead of the kept file, and `--offline` skips the shadow observation.

`bunker miss` belongs to the reference implementation, which is private and not in the public release payload.

The command refuses a duplicate question id, an existing question file or kept case, a `Questions/` or `Labels/` directory that resolves outside the ISA's directory, and a producer the read-only check rejects. If any step fails it rolls back: the registry entry, question file, kept case, seed and ledger return to their prior state and any directory it created and left empty is removed. It never edits the ISA. When the criterion has no matching `glance` row yet, it prints the Test Strategy row to paste. Source: `LIFEOS/PULSE/Bunker/src/miss.ts` (not in the public release).

## Related

- **Concept:** `../LifeOs/HillClimbing.md` § 3 (Assay is the altimeter) and § 9 (gates only read).
- **Feeds me:** `../ISA/ISAFormat.md` (the Test Strategy rows); `../Assay/AssaySystem.md` § Judgment layer (`decide()` for `glance` rows); `../Assay/AssaySystem.md` (the check schema and judges).
- **I feed:** `../ISA/ISASystem.md` (the run ledger a close reads); `../Assay/Records.md` (run results beside receipts); `../Vigil/VigilSystem.md` (a confirmed alert on a pageable row at `high`, its recovery at `info`, every other flip at `low`).
- **ISA:** `LIFEOS/PULSE/Bunker/ISA.md` (maintainer-side; NOT in the public release payload).
