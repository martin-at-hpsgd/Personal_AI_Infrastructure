---
version: 0.8.0
last_updated: 2026-10-26
last_updated_by: da
convention: lifeos-freshness-v1
status: building
---

# STATVS — the one record of state

> Everything that happens in LifeOS, and in every app it runs, is written once to one record. Every other piece of state is computed from that record and can be thrown away and rebuilt. The name is the Roman spelling of *status*, carved with a V the way SPQR is; say it "status".

STATVS answers one question for the whole ecosystem: what happened, and therefore what is true now. Before it, every subsystem kept its own diary in its own format with its own lock code, and Vigil then translated each diary into its own format again. STATVS replaces those private diaries with one record, so there is one place the truth lives and everything else is a view of it. Criteria and build state live in the ISA: `LIFEOS/STATVS/ISA.md` (maintainer-side; the ISA does not ship). This doc explains the shape.

> **Release note:** this document is the concept, the design every LifeOS install builds its state against. The engine (`LIFEOS/STATVS/`, CLI `Statvs.ts`, and the cloud core in `LIFEOS/STATVS/core/`) ships in the public release payload. The record itself lives in the install's own cloud account, and the install's own settings live in `LIFEOS/USER/STATVS/` (setup: `../Setup/Statvs.md`); neither ships.

**In the quality loop** (concept: `../LifeOs/HillClimbing.md`):

- **Owns:** the record of everything that happened, the views folded from it, and the proof that every view can be rebuilt.
- **Never does:** decide what the principal hears about (Vigil), decide what is worth remembering (Cortex), judge an output (Assay), or rule on which moves are allowed (that is the state machine of whatever system the work runs in).
- **Reads:** rows from every writer: hooks, tools, workflows, subsystems and ecosystem apps.
- **Writes:** the record, the views, and one number that says how much of the system's state it can rebuild.

## The idea

Some state records **things that happened**: a work item changed phase, a hook blocked a command, a workflow run finished, a deploy went out, a customer signed up. The rest is **computed from those things**: `work.json`, a hook's memory of what it already nudged this session, a dashboard count, a cursor.

LifeOS kept both kinds side by side in `MEMORY/STATE/` (82,326 files on 2026-10-15) and treated the folder as disposable, so history quietly disappeared. The work-event log was wiped about every nine hours until 2026-10-15, and per-session hook notes vanished when the session ended. STATVS separates the two kinds. Things that happened go into the record and are never rewritten. Everything else is a **view** that is declared as a fold over the record and can be rebuilt on demand.

The top test for the whole system: **delete STATE, rebuild it from STATVS, and lose nothing.** `Statvs.ts drill` runs exactly that test against a copy and reports what it could not rebuild. That loss count goes down with every system that moves in.

## A record, not a state machine

STATVS is easy to confuse with a state machine, and the two do different jobs (principal directive, 2026-10-16).

- **A state machine structures work.** It names the phases work moves through and the moves allowed between them, and it refuses any move that is not on its map. It holds only the present: where the work is now. The release process (bump, tag, release candidate, public, with public reachable only from a release candidate and only on {{PRINCIPAL_NAME}}'s go-ahead) has that shape, though today most of its moves are written as prose with per-command checks rather than one declared machine.
- **STATVS records what happened.** It keeps every move that was made, by whom and when, and computes the present from those moves. It rules on no move. A state machine decides whether a move is allowed; STATVS records it once it is made, so a refused move can be recorded too.

They work together. The system a piece of work runs in enforces its rules, and STATVS keeps the history, so "where is release 8.432, how did it get there, and what is it allowed to do next" has one answer.

What STATVS adds is reproducibility. Because the record holds every move, any past situation can be rebuilt and studied, a failure can be reproduced and its fix proven, and a process can be measured and hill-climbed. The test of a state record is therefore two steps:

1. **Rebuild.** From the record, and the things its rows point to (transcripts, commits), regenerate the full situation you are troubleshooting. `drill` and `compare` test this for every view; `Rewind.ts` does it for one past turn.
2. **Replay.** Run that situation again with the fix in place and watch the failure change. Replay has two tiers:
   - **Gate flip (built).** `Assay.ts replay` runs a turn's recorded tool calls through today's guards. It proves a guard now refuses what it allowed, and nothing about what the agent would have done next.
   - **Behavior replay (not built).** For a prompt or doctrine fix: the turn row pins the exact model, an unfixed control arm runs on the same model, k samples give a pass rate, and held-out past successes must not regress. Until it exists, such a fix's proof is owed and said so.

Rebuilding proves the record understood what happened; replaying proves the fix at the tier it reached. A model's own answer cannot be regenerated byte for byte, because it samples differently each run, so a rebuilt turn reproduces the conditions of a failure, never a recording of it (§ Rewind).

## The place in the stack

| Layer | System | Job |
|---|---|---|
| Record | **STATVS** | keep what happened, once, in one format; rebuild every view from it |
| Watch | Vigil | gather events from every subsystem into one central, cloud-readable store (summaries, privacy-filtered, each pointing back to its source), and decide whether to interrupt the principal |
| Remember | Cortex | curate what is worth knowing and recall it into context |
| Measure | Assay | check outputs against the ideal state they were made for |
| Change | Ledger | version every change to the system itself |

STATVS sits under everything. Vigil's own design said "every subsystem writes what happened to one log", but its emitters were adapters copying from each subsystem's private ledger after the fact, and its store holds summaries with restricted data stripped out, which makes it a notice board and not the record. STATVS moves that one-log idea down a layer: subsystems write their facts to STATVS directly, and Vigil reads the record to decide what is worth saying. Cortex keeps its job as the second brain. Its ledger engine (lock, sequence, hash chain, redaction tombstones, torn-line recovery) is the most complete one in the tree, so STATVS is built from that code.

## The record

The record is plain text (AD-9): JSONL rows. The authority is the cloud record (§ Where the record lives). On each machine a row is written first to that writer's segment under `LIFEOS/MEMORY/STATVS/`, which is the machine's spool to the cloud, never a second authority.

**One row shape.** Every row carries the same envelope and its own data:

| Field | Meaning |
|---|---|
| `v` | row format version |
| `id` | unique row id |
| `seq` | the row's position in its segment, counting from 1 |
| `hlc` | hybrid logical clock: wall time plus a counter, kept per writer, so rows from different processes sort into one timeline even when clocks tie |
| `ts` | when the fact happened, as the writer states it (default: when it was written); a time more than five minutes ahead of the local clock is clamped and flagged |
| `writer` | who wrote it: `lib:work-events`, `hook:PreToolGuard`, `tool:Upgrades`, `wf:vigil-tick`, `app:vector` |
| `stream` | what it is about: `work`, `turn`, `move`, `event`, `deploy`, `app-health` (the registry in `streams.ts` is the full list); an unregistered stream is refused |
| `class` | privacy class: `public`, `system` or `personal`; the stream's class when the writer gives none |
| `app` | the ecosystem app a row is about, for operational facts only, never tenant content |
| `kind`, `severity`, `title` | optional; present on rows meant to be noticed, in Vigil's vocabulary |
| `subject` | optional; the RES the row is about, as `<kind>:<key>` (`isa:censvs`, `app:vector`); the kind must be registered in GENERA and the key may carry nothing personal (`../Censvs/CensvsSystem.md`) |
| `op` | optional; what the row did to its subject: `create`, `set`, `move`, `link`, `unlink`, `observe` or `retire`; a row with a subject and no op only appears in that RES's timeline |
| `session` | the Claude Code session id when the row came from one |
| `ref` | a pointer to where fuller detail lives (a transcript line, a commit, a URL) |
| `data` | the fact itself |
| `data_hash` | hash of `data`, which the chain covers in its place |
| `obj` | content hash of a large payload kept in the object store |
| `flags` | marks the engine added, such as `clock-clamped` or the spool entry a row came from |
| `prev`, `hash` | the hash chain within the row's segment |

**Subjects arrived without rewriting a row.** `subject` and `op` joined the envelope on 2026-10-18, and in the cloud record from schema v4, where the row hash and Merkle leaf cover both. `op` is one word from a closed list and sits outside the erasable groups. `subject` is in the erasable text group: `content_hash` commits to it and the erasure route clears it with the title, so a name that slipped past the key guard can be taken back (core 0.11.0, 2026-10-18). No row written before then is ever rewritten to add them: every stored byte stays as written and every checkpoint still verifies. The cloud index gains the two columns as an added column, and an older row's subject is derived into that index by one deterministic resolver and never written into the stored row. The index is a view, so a derived subject can be recomputed from the record at any time.

**Segments, not one shared file.** Each writer appends to its own daily segment, `MEMORY/STATVS/<privacy class>/<YYYY-MM-DD>/<writer>.jsonl`, and chains only its own rows. A single shared hash chain forks the moment two processes append at once, and one lock around every write would make every tool call wait in line behind every other. Each writer has its own kernel lock and its own clock, shared only by that writer's processes, so writers never wait on each other, and a lock whose holder dies is freed by the operating system rather than taken over on a timer. A segment per process would avoid even that lock, but hooks are short-lived processes, so it would create a file for every hook call. The hybrid clock gives one timeline across segments. `Statvs.ts seal` closes each past day's segment with a seal row carrying its row count, final hash and a hash of its bytes, and copies that seal into an anchor row in the `statvs` stream, so any edit after the fact, a truncation included, fails `Statvs.ts verify`.

**A writer never waits on a broken record.** When an append cannot be written (a full disk, a read-only directory, a lock held too long), the row goes to a local spool and the writer carries on. The next good append drains the spool first, so spooled rows land in the order they were written. The one exception is a gate writing its `move` row on a deadline: it passes `noDrain`, queues behind any spooled rows without draining them, and leaves the draining to the next ordinary append. Every refusal, spooled row and quarantined torn line is counted, and the daily drill reports the counts.

**Masking, and one way to remove anything.** A secret value is masked in place, field by field, at the writer and again at the intake, so the rest of the row survives; nothing is refused whole for carrying a secret. Removing stored content has exactly one path, the audited erasure route, limited to a leaked secret, customer data, or another person's personal data that got in by mistake. Each use needs the principal's logged yes and leaves a tombstone row saying what was removed and why. A cloud row (schema v3) commits to its content only through two hashes: `data_hash` for the payload and `content_hash` for its text fields (app, kind, severity, title, session, ref, and a v4 row's subject). Its hash and its Merkle leaf cover those two hashes, never the content, so the erasure route can clear the payload, the text fields, or both, each group whole, and the row keeps its hash and every checkpoint still verifies. Erasing also deletes the payload's stored body and every view checkpoint and output that folded the row, so the content does not survive in STATE. The route is `POST /erase` on the cloud core, taken only with the erase credential that no writer or reader holds; its client, `core/tools/erase.ts`, runs only at a terminal so the principal types the approval himself, and the core writes the signed tombstone before it removes anything. Rows stored before schema v3 (the first 219 cloud rows, 2026-10-17) hash their content directly and stay as written. Nothing is ever removed by age.

**Privacy classes never share a file.** The class is the first directory, so health and money rows never sit in a file that may leave the machine, and a reader is given only the classes it may see. There is no customer class: customer information never enters (§ Where the record lives). A `public` or `system` row whose content looks like personal data (an email address, a health reading, a money amount) is refused, and a row that names no class and whose stream names none is written as `personal`. Rows that carry the principal's own words, such as the work stream's task and criteria text, are `personal`.

**Large payloads go to the object store.** Anything over 64 KB is written once to `MEMORY/STATVS/objects/<hash>`, named by its content hash, and the row carries the hash. The same screenshot or prompt snapshot stored twice takes the space of one.

## Writing to the record

Every row enters through one function, `append()`, imported from `LIFEOS/STATVS/index.ts` and never from `lib/`. Every specialized writer below is a thin layer over it, so validation, refusals, the spool, the hash chain and the counters apply to every row the same way. Nothing writes a segment file directly. The segments on a machine are its outbox to the cloud record (§ Where the record lives). The existing parameters of `append()` are fixed through the migration; a new optional field may be added only in a reviewed commit, which is how `subject` and `op` arrived (2026-10-18).

```ts
import { append } from "<config root>/LIFEOS/STATVS/index.ts";
const r = append({ writer: "tool:Example", stream: "work", data: { what: "happened" } }); // class, app, kind, severity, title, session, ref, ts, subject, op optional
if (!r.ok) // r.refused names the rule that refused it, or r.spooled says it is waiting in the local spool
```

| Writing | Use | Why not plain `append()` |
|---|---|---|
| Anything notice-worthy: a failure, an alert, a finished job | `writeEvent()` or `writeEventOnce()` (dedup across a window), or `Statvs.ts event` from a shell | it validates Vigil's vocabulary (kind, severity, source) and dedup key, which Vigil reads |
| A gate that refuses, asks, defers or breaks | run the gate through `runGate` or `runGateSync` in `hooks/lib/gate-run.ts` | the `move` row is written for it, and an allowing verdict costs nothing |
| A human prompt | the turn hook (`lib/turn.ts`) | already written once per prompt, with the transcript offset Rewind needs |
| Work items | `hooks/lib/work-events.ts` | dual-writes the old work log and the `work` stream while that migration compares |
| A change to a RES: creating it, setting fields, moving its state, linking it, observing it or retiring it | the matching function in `LIFEOS/CENSVS/res.ts` | it mints ids that are never reissued, sets `subject` and `op`, and checks a move against the kind's map in GENERA, writing a refused move to the `move` stream instead |
| A quality-loop fact: an output crossing a boundary, an Assay receipt, a label, an erratum, a skill run, a tool run, a render | `recordOutput`, `recordReceipt`, `recordLabel`, `recordErratum`, `recordSkillRun`, `recordToolRun` or `recordRender` in `LIFEOS/STATVS/lib/quality.ts`, called from the one choke point each record already passes through (streams `output`, `receipt`, `label`, `errata`, `skill-run`, `tool-run`, `render`); `renderFor(sha256)` reads back which pipeline made some bytes | each stream keeps its own writer and row shape; digests are stored under keys that name them as digests so the credential check passes them; receipts carry counts and ids, never finding text, and errata rows carry ids and classes, never the complaint's words; a refusal is returned and logged, never thrown, so a broken record never breaks the caller |
| A commit in a private tree | `LIFEOS/TOOLS/CommitOwn.ts`, which writes the `commit` row itself | it is the one door those commits pass through, and it knows the session; turn rows cannot say who committed, because sessions share a tree and a commit appears in every session's next turn. The full id sits in data as `commit_sha1`, since a bare 40-hex run is refused as credential-shaped |
| Anything else that happened | `append()` on a registered stream | — |

The rules a writer follows:

- **The stream must be registered.** Each stream is one entry in `LIFEOS/STATVS/streams.ts` naming its owner file, its privacy class and `retention: "forever"`. An append to an unregistered stream is refused.
- **The writer name says who wrote it,** as `kind:Name`: `lib:`, `hook:`, `tool:`, `wf:` or `app:`. Each writer appends to its own daily segment and keeps its own clock.
- **Rows carry facts, not secrets or tenant content.** Secret values are masked at the writer. Personal-looking content on a `public` or `system` row is refused. Customer information never enters. Titles and subjects stay free of restricted content: erasure can clear them with the text group, but only on the principal's typed approval, so writers keep them clean in the first place.
- **Pass `session` when a Claude Code session caused the row,** and `ref` when fuller detail lives elsewhere (a transcript line, a commit, a URL). A row without them cannot be tied back to what caused it.
- **Large payloads go by hash.** `data` over 64 KB is stored once in the object store, and the row keeps the hash.
- **Tests never touch the live record.** Under `bun test`, a writer reaches a record only through an explicit `STATVS_DIR`.
- **A private log is not a record.** Code that keeps its own JSONL or JSON of things that happened has not reported in, however complete that log is. New code writes rows. An existing log moves in through the five steps in § The migration, starting with a dual-write through `append()`, and has moved only when its old store is gone.

Whether a system reports in is answered from the rows, never from its own log: the Statvs skill's Coverage intent gives a yes, partial or no per stream, with the writer and the last row time.

## Views

A view is any file computed from the record: `work.json`, a hook's per-session notes, a Pulse count, a cursor. Each one is registered with what it reads (streams and classes), the fold that builds it, where it lives, and a checkpoint (the segment offsets it has folded up to). Reading a view folds only the rows past its checkpoint, so it stays fast however long the record grows. `Statvs.ts rebuild <view>` throws the file away and rebuilds it from the record; `Statvs.ts drill` does that for every view against a temporary copy and diffs the result with the live files.

A file that cannot be rebuilt this way is either a view that has not been registered yet or a private record that has not moved in. Both count against the drill, and both are migration work.

## Where the record lives

The record lives in the cloud, on the install's own Cloudflare account, and that copy is the authority. It is an index any authorized client can query, from a phone, Pulse or another machine, plus a body store for large payloads. Every machine and every app is a writer of that one record. A writer that is offline spools its rows locally and sends them when it reconnects, so a lost connection delays a row and never loses it. Questions are answered from it too: `tail`, `reconcile`, the Coverage tool and Rewind's turn lookup read the cloud by default (`lib/cloudRead.ts`), and `Statvs.ts compare-cloud` proves every local row is there with the same hash. The shipper runs every minute, so a cloud answer is at most about a minute behind. The local segments are on their way to becoming only an outbox that empties once the cloud confirms each row; until then each of those tools keeps a `--local` switch. The per-writer segments under `MEMORY/STATVS/` are where the engine started and what a writer spools into; they are not a second authority. On a Mac the shipper (`core/tools/ship.ts`, scheduled by the `statvs-ship` Workflow) sends them: it masks every secret, our own secret values by exact match whatever their shape, withholds any Claude Code session that touched a consulting project, and withholds any session whose transcript can never be found (an id that is not a Claude Code id at once, a Claude Code one after 24 hours of observed waiting) as an `uninspectable` marker, so one stuck session cannot hold back the rest of its segment, and stops at any row the core refuses for a reason a code fix can cure, so a fixed masker ships that row on the next run instead of losing it.

A stream that declares `ship: false` in `streams.ts` (Atlas's estate `observe` rows today) never ships its plaintext. Its rows ship a content-free `local-only` marker in their own slot, and `Statvs.ts seal-copies`, which the ship workflow runs first, writes one `sealed-copy` row per such row on the `statvs` stream: the row's exact local line, and its object when the payload lives in one, encrypted with age to the recipient that seals `.env`. That copy ships like any other row, so the cloud holds the row only as ciphertext, and `compare-cloud` counts each one as sealed. Customer rows never leave the machine in any form.

The cloud core orders every row into one append-only log, signs a checkpoint over it after each batch, and keeps the tree in tlog tiles. Each day the `statvs-witness` Workflow verifies the latest checkpoint and its consistency proof from the one it witnessed before, then commits it to the private USER git repo, so a rewrite of history on Cloudflare would fail that proof against a root held somewhere else.

The record is permanent. No row is ever removed by age, and the cloud store runs no retention sweep: its daily job only recounts its totals. The one exception is the erasure route (§ The record), which clears a row's content and keeps the row, its hash and its place.

Rows are plain and readable. The only thing masked is a secret value: a key, token, password, cookie or connection string. Customer information never enters the record at all: rows about a tenant of an app other than the principal's own business, and any customer consulting work, are refused by provenance at the writer and at the intake. A refusal leaves a `withheld` marker row carrying its source and count, never its content.

## What STATVS is the authority for

STATVS is the authority for **what happened** across LifeOS and every app in the ecosystem. Something absent from STATVS is unknown until reconciled, never assumed not to have happened: a record with gaps would otherwise write a confident false history, so gaps are found by comparing the record against independent witnesses (git, deploy logs, transcripts) and closed. Three things stay outside it on purpose, and each has its own authority:

| Kept elsewhere | Authority | What STATVS holds instead |
|---|---|---|
| Product data: customer records, messages, content inside an app, macOS databases | that app's own database | operational facts about the app (deploys, health, errors, signups as counts) and pointers, never tenant content |
| Code and doctrine | git | deploy and change rows that point at commits |
| Secrets | Keychain and the sealed `.env` | nothing, ever |

Claude Code sessions are not on this list. They are imported in full, with the same chain and verification as any live row, because replaying a past turn needs what was said as well as what happened, and a pointer into a file on one machine cannot be followed from anywhere else.

## The record checks itself

The rule above (gaps are found against independent witnesses) runs every hour as the `statvs-reconcile` workflow, `Statvs.ts reconcile`. It reads the last two hours and compares the record with what saw the same moments from outside:

| Gap | Witness | Example of what it catches |
|---|---|---|
| `turn` | each Claude Code transcript's human prompts | a prompt with no `turn` row, so Rewind cannot restore its conditions |
| `move` | tool calls a command hook refused, in the transcript | a gate that refuses without writing its `move` row |
| `move-plugin` | the same for the in-process plugin | refusals the plugin cannot record yet |
| `ship` | the shipper's cursor | a row more than an hour old that never reached the cloud record |
| `schedule` | a fresh compile of each workflow definition | an installed schedule firing at the wrong hour |

Each gap becomes one Vigil event per check per day, carrying its count, short session ids and the command that fixes it, never prompt or row content. Reconcile changes nothing itself: fixing stays the principal's or a session's job, and the event says how. Without `--emit` it only reads. Before this check existed, four gaps sat unseen for up to six days (2026-10-22).

## The ecosystem

Apps that run in the cloud write to the same cloud record as every machine, under `writer: app:<name>`: a Worker on our account appends through a service binding, and anything else sends rows with that app's own scoped credential. A writer that cannot reach the record spools its rows and sends them later, so an outage delays rows without losing them. Each app carries a STATVS policy naming which streams and privacy classes it may write, and the intake refuses anything above that ceiling, the same rule Vigil already applies to its emitters.

## Rewind

Because the record holds both what happened and what was said in each Claude Code session, a past turn can be put back together from the record alone. Every human prompt writes one `turn` row: the transcript offset, both repos' full commit id with a hash of their uncommitted changes, this Mac's keyboard idle time, the model and effort the turn ran on, the notification channel, and the size of today's and yesterday's record segments (older days are sealed). When the tree moved since the session's last turn, the row also points to the uncommitted changes and untracked files themselves, stored once in the local object store by hash; those bodies are never shipped or backed up. `Rewind.ts input <session> <turn>` (or `--errata <id>`, which finds the turn a complaint was about) builds a fixture from the transcript's messages after the last compaction, the system prompt and tools of the turn's recorded request, every tool call with its outcome, and the conditions the turn row recorded; a condition that was never recorded can be stated with `--assume`, and the fixture says where it came from.

`Assay.ts replay <fixture>` runs the turn's tool calls through today's guards in a sandbox under those conditions and records whether the miss flips: a call that ran then and is refused now. A call whose guard reads state the fixture does not carry, or refuses without declaring what it reads, is reported `unreproduced` and not flipped, because the empty sandbox may be the reason. The first one was a complaint that an image had been opened on the empty desktop while the principal was on a laptop; replayed with the desk idle, today's SeatGuard refuses both `open` calls, and with the desk in use it allows them. Replaying the model's own answer comes next. A model's sampling cannot be replayed exactly, and some request blobs are never written to the transcript, so a rewind is a reproducible fixture, not a recording.

## The migration

STATVS becomes authoritative one system at a time. Every move follows the same five steps, and a system has only finished moving when its old file is gone:

1. Write to both the old store and STATVS.
2. Build the view from each.
3. Compare them until they match.
4. Switch every reader to the STATVS view.
5. Delete the old store, its private lock code and its Vigil adapter.

Work events move first, since they are already a fold of an event log. Rewind comes next, ahead of any other system: the record is the save half of the harness and replay is the half that reproduces a miss and proves its fix, so STATVS grows where a replay fails for lack of something recorded. Then the hook journal and per-session hook notes, workflow runs, Vigil reading the record directly, and the ecosystem apps through the intake. Cortex's memory ledger is already an append-only, hash-chained log kept in git, so it does not move: STATVS reads it where it is.

Step 5 never runs on a day the restore drill failed. Deleting an old store is only safe when the record that replaces it can be restored. Three numbers show how far it has come: the drill's loss count, Vigil engine adapters still translating a private ledger (21 on 2026-10-15), and separate lock implementations (22 files on 2026-10-15).

## Backup

Until the cloud record carries every row, the segments on the writing machine are backed up as age ciphertext: `Statvs.ts backup` encrypts every system and personal segment, and every large-payload object those rows point to, to the same recipient that seals the secrets file, and writes them to a backup folder in the private USER data repo. A file is re-encrypted only when its bytes change, so a sealed day is written once, and an object removed by redaction is removed from the backup too (git history still holds its old ciphertext). `backup` then copies the changed ciphertext, and a manifest encrypted the same way, to a private R2 bucket, which holds only ciphertext; `Statvs.ts restore-drill --offsite` downloads that copy alone and runs the same drill on it (ISC-108). `Statvs.ts restore-drill` decrypts the whole backup into a temporary folder, runs `verify` on it, and checks every restored file is the live file or an earlier prefix of it.

## What is built

Build state lives in the two ISAs (`LIFEOS/STATVS/ISA.md` (not in the public release) and the full-migration ISA it names), and the live numbers come from `Statvs.ts drill` and the Statvs skill's Coverage intent; this section does not track them. One difference matters to a reader today: the local engine every `append()` call reaches still refuses a row that carries a secret and still accepts a `customer` class, while the cloud core being built beside it (`LIFEOS/STATVS/core/`) masks secrets in place and has no customer class. The design in this document is the core's; the engine follows it at cutover.

## Related

- **Doctrine:** `../LifeosSystemArchitecture.md` § AD-11 (one record of state), which generalizes AD-1 and AD-2; AD-9 (state is text) still binds.
- **Nouns:** `../Censvs/CensvsSystem.md` (CENSVS, AD-12): every noun is one RES, and its state is the rows that name it in `subject`, folded.
- **Watch:** `../Vigil/VigilSystem.md`, the first reader moved onto the record.
- **Second brain:** `../Memory/MemorySystem.md`; STATE becomes a set of STATVS views.
- **Analysis behind the design:** maintainer-side; does not ship.
