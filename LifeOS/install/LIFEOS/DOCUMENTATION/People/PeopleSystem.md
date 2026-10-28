---
version: 1.1.0
---

# People — the one local people system

> One record per human and organization the principal knows, on this machine,
> that answers the whole question in one command: who they are, whether they are
> personal or business, every interaction and of what kind, and whether they are
> or ever were a customer. Apple Contacts stays the phone's view and is kept in
> step for identity. Every other source flows in on an hourly schedule. The
> shared cloud tenant gets a business-only projection, by explicit command only,
> and never sees the personal half.
> ISA (state of record): `LIFEOS/PEOPLE/ISA.md` (maintainer-side; the ISA does not ship).

## The loop

```
sources (read)                    the store (private USER tree)        surfaces
──────────────                    ────────────────────────────        ────────
Apple Contacts (two-way, identity) ┐                                ┌→ people who <x>
Gmail metadata                     │                                │
calendar attendees                 │                                ├→ people list --class
                                   ├→ hourly tick ─→ merge ─→ ──────┤→ people stats
                                   │                                ├→ people history <x>  (texts, groups, mail)
Stripe                             │   (launchd,      one writer    ├→ ContactsDb shim (deprecated)
newsletter                         ┘    headless)                   └→ people push  ← the only way up
                                                                        (business records only)
```

The tick is the unattended half. It runs the sources in a fixed order, each one
isolated, then rebuilds the store; every run appends a row saying what each
source did. The CLI is the interactive half and the only surface in this
milestone — no Pulse board, no web UI.

## The boundary

The security boundary is structural, not a rule someone has to remember.

- The tick module imports nothing that can reach the cloud tenant. Its transitive
  import graph is walked by a test and fails if the boundary module appears in
  it. A scheduled job cannot call what it has no path to.
- Exactly one module in the subsystem names a tenant client, and it is the
  boundary module. The refusal lives in the library function, not in the CLI
  parser, so a future hook or script calling it directly is refused identically.
- The only shape that may leave the machine is an allowlist projection built
  field by field — name, organization, business-domain addresses, and
  business-kind interactions (kind and timestamp only, at most 50, never a subject line, automated mail, text or call). It is never a copy of the record with the personal
  parts deleted, because a deletion list fails open the day a field is added.
- Only a record whose effective class is `business` may be projected. `personal`,
  `both` and `unknown` are all refused: a record that is partly personal still
  carries personal facts, and a founder's customers are often also friends.
- Nothing is actually sendable yet. The tenant exposes no create tool, so the
  push path reports `not-yet-sendable` and prints the projection rather than
  claiming a send that did not happen.

## The class rule

Every record carries a class derived by one rule function, with a hand override
that always wins.

| signals | class | reading |
|---|---|---|
| address book (or curated) + product identity | `both` | a customer who is also a friend |
| product identity or an organization card only | `business` | a company card, or a customer never filed |
| address book only | `personal` | a filed human with no product identity |
| neither | `unknown` | an email-derived record we know nothing else about |

`unknown` is a real answer, not a failure: most records are email-derived, and
guessing would be worse than saying so. An organization card in the address book
derives `both`, so a personal vendor card can never be projected without an
explicit override.

## The CLI

```
people who <name|email|fragment> [--json]     class, interactions by kind, customer state, recent contacts
people list [--class X] [--limit N] [--json]  every record, optionally by class
people stats [--json]                         counts, customers, interactions, per-source freshness
people merge [--curated <file.md>] [--json]   rebuild the store from its sources
people tick [--json]                          run every source, then merge; one run row
people sync apple [--json]                    pull every Contacts card in, then rebuild
people add --name|--org …                     create the Apple card AND the local record
people push <id> [--json]                     project one BUSINESS record; refuses anything else
people texts <name|email|fragment> [--limit N] [--json]   the person's recent texts, both directions
people history <name|id|email|number> [--since <date> | --all | --limit N] [--search <words>] [--json]
                                              everything the DA exchanged with them, all channels, time-ordered
people history --rebuild                      regenerate the per-person history files from STATVS alone
people backfill [--dry-run] [--no-mail] [--json]   one-time: file pre-person texts and the DA's sent mail under each person
people link <id> <id> [<id>...] [--json]      record that these records are one human; the next merge folds them
```

`texts` reads the Messages reader's private state (`threads.json` and `inbox.jsonl`
under `~/.local/state/lifeos/messages/`); People never opens `chat.db`. A person
matches on their phones (last ten digits) and emails. On the terminal `who` adds a
`texts:` line with the count and latest time, never the text itself. On any other
channel (`LIFEOS_NOTIFICATION_CHANNEL` set, as in the iMessage bridge's sessions)
`texts` refuses with exit 3 and `who` leaves that line out, since those sessions
answer people other than the principal.

`tick`, `sync apple` and `add` reach Apple Contacts through a Swift adapter whose source ships in
`LIFEOS/PEOPLE/ContactsCli.swift` (macOS only; `swiftc` compiles it on first use). Without the macOS
Contacts permission, or off macOS, `sync apple` and `add` fail; `tick` still runs every other source and
records the Apple source as `blocked` (no permission) or `failed`. Services.ts lists the hourly service only
where the contacts-photos skill's copy of the adapter exists; elsewhere run `tick` by hand or install it with
`InstallPeople.ts`.

`history` and `backfill` read and write message text, so they follow the same terminal-only rule as `texts`: off
the terminal both refuse with exit 3. `history` with a name that matches more than one person prints the candidates
and exits 1 (`ambiguous`), and with no match prints `no match` and exits 1.

Every query command takes `--json`. Exit codes: 0 ok, 1 not found or usage, 2
unknown subcommand, 3 refused or not sendable.

`people add` is the one call site of the Apple write capability in the whole
subsystem. The adapter takes an origin token and accepts exactly one value, so a
sync-derived merge physically cannot push an address onto a card: sync-derived
merges stay local. There is no delete path at all, on either side of the adapter.

## The tick

Sources run in order: Apple Contacts, Gmail, calendar, Stripe, the newsletter,
then the merge. Each runs inside its own try/catch, so one failing source is
recorded as `failed` with its message and the rest still run. A source with no
key configured records `skipped`, which is a different fact from `failed` and is
stored as one. A source waiting on a human grant (a macOS permission, a re-authorization) records `blocked`, also distinct from `failed`, because no code fix clears it and `renderRun` says so. The run row is appended even when every source fails — a tick that
wrote nothing because everything broke would look exactly like a tick that never
ran.

The two customer sources fetch in their own slot but their result is applied by
the merge at the end, so the store is written once per run rather than three
times.

Every source is bounded to ten minutes of wall clock. Each one is a paginated
sweep of a remote backend with a per-request timeout but no bound on the loop, so
a long enough subscriber list or a slow enough backend can run for hours — on an
hourly job that is indistinguishable from a hang, because the store simply stops
being rebuilt. A source that overruns is recorded as `failed` like any other and
the run moves on; the command then exits the process explicitly, since the
straggler is still fetching with nothing left to await it.

`people stats` prints each source's last successful run and flags anything older
than 48 hours, which is how a quietly broken source becomes visible.

Scheduled as `com.lifeos.people` (hourly, `StartInterval` 3600), registered in
`LIFEOS/TOOLS/Services.ts`, installed by `LIFEOS/PEOPLE/InstallPeople.ts`.
`RunAtLoad` is false on purpose: the tick rewrites the live store, so installing
the job must never itself trigger a write. Headless by contract —
`LIFEOS_NOTIFICATION_CHANNEL=headless` silences every voice-firing hook, and the
tick module imports no notification client, so there is nothing there that could
speak even if the variable were lost.

## Per-person history

People owns who a person is, so it also owns each person's history with the DA across channels (People ISA F8,
ISC-51 to ISC-57). Three pieces:

- **One resolver** (`Identity.ts`). Any handle, a phone in any format, an email or a thread id, maps to one People id
  through the People store and the Security Rings member lists; there is no identity table of its own. Records joined
  by a curated `same_as` edge, or listed under one Ring member, are one person. A handle no record carries, or that two
  different people carry, resolves to the unknown sender and is never given a guessed name. Relay, `gmail.ts` and the
  history all resolve here. Its scrubber removes numbers and email addresses from names and notes and keeps dates.
- **A projection of STATVS** (`History.ts`, `HistoryFacts.ts`). `people history` reads plain-text shards, one
  JSONL file per person per year, each line versioned, kept under the STATVS views directory in the private USER tree.
  Directory names are the percent-encoded People id, so no phone number or email address names a directory or fills a
  shard line. Texts, group lines and the DA's mail merge into one time-ordered history. A group line appears in the
  history of every member of its group, including a member who joins later. A live fact replaces any backfilled fact
  with the same key. An incremental follow applies only rows after a cursor; `people history --rebuild` regenerates the
  tree from STATVS alone, resumes if cut short, and equals the incremental result. The STATVS view `people-history`
  holds the same fold, and `Statvs.ts compare people-history` proves the shards match the record. Erasure through the
  STATVS route is not followed automatically: after one, run `people history --rebuild`.
- **A one-time backfill** (`Backfill.ts`, `people backfill`). It files texts from before rows carried a person, group
  lines and the DA's Sent mail under their person, masked the way Relay masks its own rows, every row marked as
  backfilled with its original time and a key that makes a re-run add nothing. It writes nothing when the bridge
  config its masks come from cannot be read, and prints names and counts only.

`people link` is how the principal says two records are one human: it adds the `same_as` edge through the store's one
writer, never removes an edge, and refuses an unknown id. The next `people merge` folds the records, so each person's
history is whole.

The history is a view of the record, never a second store. The shard writer names no store file, and
`tests/single-writer.sh` allows it as the one writer besides `store.ts` and the installer.

## Data files

The three store files are plain JSONL under the private USER tree, mode 0600, written by one
module and no other. No SQLite, no binary store. The per-person history shards above are a rebuildable view under the
STATVS views directory, not part of the store.

| file | holds |
|---|---|
| `contacts.jsonl` | one record per person, with per-field provenance and the values a merge replaced |
| `interactions.jsonl` | append-only typed events: email, calendar, text, call, meeting, note |
| `runs.jsonl` | one row per tick, per-source status in `ok \| failed \| skipped \| blocked` |
| `cache/` | the Apple audit dump, the Gmail metadata cache and its checkpoint |

Every write asserts the record shape before touching disk, writes to a sibling
temp file, chmods it, and renames it over the target, so a reader never sees a
half-written store.

Records fold only on a shared email, a shared phone, or a curated `same_as` edge
— never on a name. Two humans with one name stay two records. Fields merge
last-write-wins by provenance timestamp and the losing value is retained, so a
bad merge is reversible. Identity arrays union rather than replace, which makes
removing a value an explicit act instead of a side effect of a sync.

## Deprecated: ContactsDb

`LIFEOS/TOOLS/ContactsDb.ts` was the pre-People pipeline. It is now a read-only
shim that answers through this subsystem and prints one deprecation line per run.
It holds no write of its own — exactly one code path in LifeOS writes the store.
`search`, `get`, `list`, `stats` answer; `sync-gmail` and `merge` delegate;
`sync-addressbook`, `bulk-set-summaries` and `evidence` exit 2 with a pointer.
The shim ships for one release.

## Tests

`bun test ./LIFEOS/PEOPLE` (source tree only; tests are not in the release payload) is the entry point, plus the bash probes under
`LIFEOS/PEOPLE/tests/` (source tree only). Every row runs against a scratch store pointed at by
`PEOPLE_DIR` with synthesized fixtures; no test reads the live files. The Apple
rows are the one exception: they touch the real Contacts store on purpose, because an
adapter verified against a stub proves nothing about the framework, but only when
`PEOPLE_APPLE_LIVE=1` is set (ISC-57). Routine runs skip them and never touch the address
book, since a failed cleanup once left 73 marker cards behind. When opted in, they create
only marker-named cards and remove them afterwards.

Pass the path with a leading `./`. A bare pattern argument (`bun test
LIFEOS/PEOPLE`) makes Bun 1.3.6 drop every child process's captured output, so
rows that spawn a process fail for a reason that has nothing to do with them.

## Relationship to neighbours

Contacts photos stay with the optional contacts-photos skill, if installed, which owns the photo write path
and keeps an identical copy of the Swift adapter this subsystem shells out to (`tests/apple.test.ts` holds the two the same). The curated hot list of
people stays where it is; this store is the full record behind it. Cortex holds
what was said and decided; People holds who was there, and its history shows what the
DA and each person exchanged. Relay and `gmail.ts` write the rows that history reads, and
resolve their handles through People's `Identity.ts`. The shared cloud tenant
holds the business view of customers and is a projection of this store's business
slice, never a source for it.
