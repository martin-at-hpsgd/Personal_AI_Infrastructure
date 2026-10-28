---
version: 0.3.2
last_updated: 2026-10-20
last_updated_by: da
convention: lifeos-freshness-v1
status: building
---

# CENSVS: the register of everything LifeOS owns

> Every noun LifeOS owns or watches is one RES, Latin for "thing". GENERA is the closed list of the kinds a RES can be. CENSVS, said "census", is the register of every RES, and STATVS is what happened to each one. A RES's current state is its STATVS rows folded.

CENSVS answers the question STATVS leaves open: what exists, and what is each thing like right now. STATVS gave LifeOS one record of verbs. CENSVS gives it one shape for nouns, so ids, states, links and history work the same way for an ISA, an app, a proposal, a domain or a person. Criteria and build state live in the ISA: `LIFEOS/CENSVS/ISA.md` (maintainer-side; the ISA does not ship). This doc explains the shape.

**In the quality loop** (concept: `../LifeOs/HillClimbing.md`):

- **Owns:** the RES shape, the GENERA registry of kinds and their allowed moves, and the writer library that checks a move before it is recorded.
- **Never does:** keep its own store. Every change to a RES is a STATVS row, and the register is a view folded from those rows.
- **Reads:** STATVS rows with a `subject`, plus git and outside authorities for the kinds it observes.
- **Writes:** rows through `append()`, and the `things` view.

## The idea

Before CENSVS, every subsystem invented its own noun store. Each had its own ids, status words, link fields, lock code and fold: the STATVS migration inventory counted hundreds of stores, a couple of dozen private lock implementations and as many Vigil adapters translating between them. Five stores held the same thing, a recommended change waiting for the principal's yes, each with its own status words. Six tools minted sequential ids by hand (`IS-`, `ACH-`, `INC-`, `R-`, `ERR-`, `SOC-`), and `R-` alone meant three different things.

Kyle Kukshtel's game, described in "Your Game Is A Harness", has one `Thing` struct with a kind enum instead of a class hierarchy. The game is a list of Things, commands change Things, and replay is the start state plus the commands. LifeOS already had the command half in STATVS. CENSVS adds the noun half.

The two systems split the work cleanly. STATVS records what happened. CENSVS lists what exists, and computes each RES from the rows that name it. A new subsystem adds a kind to GENERA and writes rows; it never builds a store.

The test is one command for any noun: `bun LIFEOS/CENSVS/Censvs.ts show app:<name>` prints the app's fields, its links, its state and every row about it in time order, all from one fold.

## The RES shape

Every RES has the same fields:

| Field | Meaning |
|---|---|
| `id` | `<kind>:<key>`, such as `isa:censvs`, `skill:Simplify` or `person:p7f3a9`; at most 256 characters, no whitespace |
| `kind` | a kind registered in GENERA, always the id's prefix |
| `title` | the human name |
| `state` | one state from the kind's lifecycle |
| `parent` | one containment link: a criterion's ISA, a DNS record's domain, a run's workflow |
| `links` | typed links, each `{ rel, to }`, pointing at other RES ids |
| `class` | privacy class, `public`, `system` or `personal`; it defaults from the kind and can only be raised |
| `authority` | where the truth lives: `record`, `git` or `observed` (§ Authority) |
| `data` | the kind's own fields, checked against the kind's schema version, capped at 64 KB |

Anything heavier than 64 KB goes by pointer: an object-store hash, a git path and commit, or a URL. The lifecycle field is `state`, not `status`, because STATVS is said "status" and the two would collide in speech.

## GENERA

GENERA is one frozen registry in `LIFEOS/CENSVS/genera.ts`, the noun twin of the STATVS stream registry. A row naming a kind that is not in it is refused. A new kind lands only in a reviewed commit to that file. Private skills add species inside a kind, never new kinds.

Each kind declares where its truth lives, its privacy class, whether its keys are natural or minted, its states, the moves allowed between them, the bucket each state reads as, its data schema version and its owner. The exact fields are the `KindDef` type in `genera.ts`; this doc does not restate them.

Every state reads as one of five buckets: draft, open, active, closed or gone. Buckets let a question cross kinds without knowing each kind's words, so "everything open" works over ISAs, findings and proposals at once. Where an existing store already uses its own word for a state, the kind maps that word to its declared state, which is how Upgrades' `recommended` reads as a `proposal` in state `proposed`.

The kinds sit in seven groups. The file is the authority for the current list; on 2026-10-17 it held 44 kinds:

| Group | Kinds |
|---|---|
| Aims | goal, risk, question, decision |
| Work | isa, criterion, issue, followup, proposal, finding, release |
| Execution | session, run, case, suite |
| Machinery | skill, hook, agent, workflow, tool, model, system, stream, view |
| Estate | app, service, domain, dns_record, store, repo, machine, credential, ingest, capability, control, account, project |
| People and world | person, org, place |
| Knowledge | note, source, piece, media |

A new kind has to pass three tests. Its instances are referred to from elsewhere, by a row, a link or a person saying its name. It has a lifecycle or schema no existing kind carries; a difference of one field is a species, not a kind. And some reader filters on it.

Two alarms guard the list from both sides, and the registry test fails on either. A kind with more than eight species has become a junk drawer and should split. Two kinds with the same states and the same moves were split for no reason and should merge. No kind or species may be named for customer, tenant or secret content.

Moves are where the rules live. Moving a RES to a state its kind does not allow from where it stands is refused by the writer, and the refusal is written to the `move` stream with from, to and verdict. Some moves need the principal's own channel: a proposal goes from `proposed` to `accepted` only on the principal's yes, and a release reaches `published` only on the principal's go-ahead. ISA phases that are retired still parse when old rows name them, but no move into them is allowed.

## Authority

Each kind says where its truth lives, and there are three answers.

**Record kinds** are owned by STATVS. A proposal, a finding, a workflow run or an Errata issue exists because rows created it, and its state is those rows folded. Nothing else holds the truth for it.

**Git kinds** are owned by git: ISAs and their criteria, skills, hooks, agents, workflow definitions, tools, models, streams, views and knowledge notes. CENSVS observes them from git with a path and commit and never copies their text. They are never hand-edited in the record, and an ISA's checkboxes stay authoritative in the ISA's markdown, so there is only one authority for done.

**Observed kinds** are owned by an outside authority: Cloudflare for domains and Workers, GitHub for repos, the host for services and machines. A collector writes an `observe` row only when what it sees appears, changes or expires, plus one row per sync run saying how complete it was. Every observed kind carries Atlas's `active`, `stale` and `expired` states and allows every move between its states, because refusing an observation would throw away the truth.

Whatever the authority, a RES never copies git prose, secret values, customer content or another program's database; it points at them. Estate rows about credentials, ingest surfaces, capabilities and controls stay on the machine and never ship to the cloud until they can be sealed.

## Rows are the verbs

A row that changes a RES names it in `subject` and says what it did in `op`. There are seven ops:

| Op | What it does to the RES |
|---|---|
| `create` | brings it into existence with its first fields and state |
| `set` | changes fields in `data`, or its title or class |
| `move` | changes its state along the kind's move map |
| `link` | adds a typed link to another RES |
| `unlink` | removes one |
| `observe` | reports what an outside authority shows now, for observed kinds |
| `retire` | moves it to the kind's first state in the gone bucket |

Any other row may name a subject without an op, so it shows up in that RES's timeline. A deploy row names the `app:<name>` it deployed, and a review row names the ISA it reviewed. The row field `kind` keeps its Vigil meaning for now; the RES kind travels only as the prefix of `subject`, and renaming the row field to `topic` waits for the next cloud schema version.

Changes go through `LIFEOS/CENSVS/res.ts`, a library with one function per op plus `mint` for new ids. Each function is a single `append()` with `subject` and `op` set, so every rule of the record applies. `move` checks the kind's map before it appends, and a set from a writer that does not own that field is flagged by the fold and never applied. `append()` itself refuses a subject whose kind is not registered, an op outside the seven, and a subject with personal-looking content. The command line is `LIFEOS/CENSVS/Censvs.ts`, named like `Statvs.ts`; `res.ts` has none of its own.

One generic fold, the `things` view in `LIFEOS/STATVS/views/things.ts`, applies the ops by subject and gives every RES its current shape. It is a STATVS view like any other, so `Statvs.ts rebuild things` throws it away and rebuilds it, and `drill` and `compare` check it. Work rows that predate subjects fold to `isa:<slug>` through a subject derived from the row, with no new data written.

The cloud record carries `subject` and `op` from schema v4 on. `op` is covered by the row hash and the Merkle leaf; it is one word from a closed list and carries nothing personal. `subject` sits in the erasable text group beside the title: `content_hash` commits to it and the Merkle leaf does not, so the one erasure route can clear a subject that slipped past the key guard, and an erased v4 row keeps its `op` and loses its `subject`. A subject is still meant to carry no personal content, and personal kinds take minted keys, because the guard is a filter and a permanent record has to be able to take back what it misses. Old rows are never rewritten: their stored bytes stay identical and every checkpoint still verifies. The cloud index gains the two columns with `ALTER TABLE ADD COLUMN`, and the subjects of old rows are derived into that index by one deterministic resolver. The index is a rebuildable view, so a derived subject can be recomputed and never becomes history.

STATVS still rules on nothing. The writer library checks a move against GENERA before it appends, and STATVS records whatever was done, a refusal included.

## Any moment, and its situation

STATVS exists so that any past moment can be rebuilt and replayed. CENSVS makes that one walk instead of a hunt across stores.

Every read takes `--at`. `Censvs.ts show <id> --at 14:20` prints the RES as the record held it at 14:20 today, in the principal's current zone; `list <kind> --at <time>`, `get` and `links` do the same. The things fold reads only the rows whose time and whose clock stamp are both at or before that moment, so a row written later about an earlier moment stays out: the system did not know it then. The source stores hold only today, so a past read never falls back to them.

`Censvs.ts situation <id> --at <time> [--depth N]` builds the whole situation around a RES at that moment. It walks from the RES through its parent, its children and its links in both directions, two steps by default, and folds each RES it reaches as of that time. It adds every row about those RES in the 24 hours before (`--window` changes that), and, when a session is among them, the turn row nearest before the moment with the environment it recorded. The result is one JSON file under `LIFEOS/MEMORY/STATE/censvs/situations/`, readable only by the principal's account, which is what a replay starts from. The file's shape is set in `LIFEOS/CENSVS/situation.ts`.

## What is not a RES

Things that happen once are rows about a RES, never RES themselves: a text, a deploy, a location fix, a gate verdict, a turn. A workflow run is a RES because it has its own states and is referred to by id; a turn is not.

A view's output is not a RES either. The `view` kind is the view's definition in `LIFEOS/STATVS/views`, owned by git; the caches, cursors and index entries a view computes from rows can be thrown away.

Content stays with its authority, and a RES holds a pointer and counts at most. That covers ISA, TELOS, doctrine and skill prose in git; code; message bodies; customer records and tenant data; secret values; and other software's databases, such as `chat.db` or an app's own D1. No kind exists for customer, tenant or secret-value content.

Some of what Atlas stores as assets today are not nouns. A source file that uses a model becomes a `data.path` on the skill, hook or workflow that owns it. A scanner target is a link from the domain it monitors, since many targets shadow a domain already. A model-source record is one collector run's coverage, so it becomes an `observe` row. The mapping lives in `ATLAS_KIND_MAP` in `genera.ts`.

## Names

**CENSVS**, said "census", is the Roman register of every citizen and what they owned. It pairs with STATVS: STATVS records what happened, CENSVS lists what exists. Lowercase "census" already means other things in the tree (EvalCensus, Atlas's injection census), so docs write CENSVS.

**RES** is Latin for "thing", Kukshtel's own word in translation. **GENERA** means "kinds"; one kind is a genus, though the code just says kind. All three are written in caps in prose.

A RES is never called an asset, an entity or a record. "The record" is STATVS, and "asset" is Atlas's word from before CENSVS. The lifecycle field is `state`, never `status`.

Ids are `<kind>:<key>`. System kinds use readable natural keys (`isa:censvs`, `domain:example.com`). Personal kinds take minted opaque keys such as `person:p7f3a9`, and a key that looks like an email address, a phone number or a name is refused. An id is never reissued, the rule IdealState already follows, and every legacy id (`ACH-0042`, `IS-0012`, `ab:…`, `gear:…`) stays as an alias that resolves to exactly one RES.

## The migration

Every system moves in through STATVS's five steps (`../Statvs/StatvsSystem.md` § The migration): write to both the old store and the record, build the view from each, compare until they match, switch every reader, then delete the old store. Deleting any old store needs the principal's yes for that store.

The first movers, in order:

1. **The work registry.** ISAs already fold from the `work` stream, so `isa:<slug>` RES come from existing rows with no new writes, and the `isa` slice of the `things` view is compared with `work.json`.
2. **Proposals.** Upgrades writes `proposal:<id>` rows beside its own store; the Review, Ideal State and memory-review stores follow once the slice matches.
3. **Workflow runs.** The engine writes `run:<id>` rows with `workflow:<name>` as parent beside its runs ledger.
4. **Atlas.** Atlas's collectors write `observe` rows for the estate kinds, while Atlas stays the collector and its graph queries keep working.

Status: steps 1 to 4 are dual-writing. Upgrades writes `proposal:<id>` rows beside its store (`LIFEOS/CENSVS/tools/seed-proposals.ts` brings older records in once), the workflow engine's ledger writes `run:<id>` rows, and `LIFEOS/ATLAS/Observe.ts` writes `observe` rows for the estate kinds. Each has a live-side slice in `LIFEOS/CENSVS/live/` (`isa`, `proposal`, `run`, `atlas`) that `Statvs.ts compare things-<slice>` diffs against the `things` fold. No old store is deleted yet.

Before any of that, a read-only resolver, `bun LIFEOS/CENSVS/Censvs.ts resolve`, maps records from Atlas, Upgrades, ISA frontmatter, Errata, Socrates, Achilles, People, workflow definitions, skills and hooks to RES without writing anything. It reports every record it cannot map, counted per source. That report is GENERA's acceptance test: a record no kind fits means a kind is missing or the record is not a noun.

Progress shows in numbers that only go down: private noun stores, private lock implementations, Vigil adapters, and records the resolver cannot map. The STATVS full-migration ISA keeps the importers; CENSVS adds `subject` to what they bring in.

Related: the ISA (`LIFEOS/CENSVS/ISA.md`, maintainer-side), the record (`../Statvs/StatvsSystem.md`), the decision (`../LifeosSystemArchitecture.md` § AD-12), the estate collector (`../Atlas/AtlasSystem.md`), and the analysis behind the design (maintainer-side; does not ship).
