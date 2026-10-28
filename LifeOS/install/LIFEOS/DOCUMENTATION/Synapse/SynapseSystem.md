---
last_updated: 2026-10-20T00:00:00Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 2.1.1
status: named-and-documented
---

# Synapse — the LifeOS Input Router

> **Synapse is how anything that crosses your attention enters LifeOS.** Every input — a URL, a bookmark, a spoken thought, a feed item, a PDF — plugs into one capture contract, is preserved instantly in the **amber ledger** (Synapse's write-ahead journal), summarized and graded against what you're actually trying to do (TELOS), and routed to the destination it earns. One contract in, weighted transmission through, the right home out.

**Why "Synapse."** A synapse is weighted transmission: a signal crosses only if it's strong enough. That is exactly this system's job — grading sets the weight, routing propagates what clears the bar, and everything is journaled before any of that can fail. The brain analogy runs through the whole stack: **Conduit and Feed are the senses** (internal and external), **Synapse is the relay that grades and routes every signal**, and **Cortex (the memory system) is the store** it promotes into.

> **Renamed from Amber, 2026-07-28.** The old name described only one stage — preservation — while the system's real identity is the router. The metaphor survives at the scope it earned: the append-only journal is still called the **amber ledger**, because an insect in amber is preserved perfectly, permanently, the moment it's caught, and that is precisely the ledger's guarantee. Prior doc: `DOCUMENTATION/Amber/AmberSystem.md` (see git history).

> **Criteria live in the ISA.** This doc explains; the maintainer-side `LIFEOS/SYNAPSE/ISA.md` (a per-instance state file, not in the public release payload) carries the subsystem's criteria with the probes that would falsify them. The concrete instance map — hostnames, worker URLs, the newsletter sheet — lives in the USER-zone ISA per `LIFEOS/DOCUMENTATION/SystemUserBoundary.md`. Deployed infrastructure keeps its internal names (the capture-ledger worker, `amber` D1, `com.lifeos.amberroute` launchd job, the `amber` CLI): identity is what changed, not plumbing.

---

## The place in the stack

| Layer | System | Job |
|-------|--------|-----|
| **Senses (internal)** | Conduit | perceives *you* — where attention actually goes (app focus, commits, sessions) |
| **Senses (external)** | Feed | perceives *the world* — polls sources, normalizes items |
| **Router** | **Synapse** | one capture contract in; journal, grade, route |
| — journal | the amber ledger | write-ahead, append-only, permanent; nothing entering Synapse is ever lost |
| **Store** | Cortex | curated KNOWLEDGE promoted from the ledger; hot-layer; retrieval |

Feed and Conduit sense; Synapse decides; Cortex keeps. Before the rename these functions were smeared across three overlapping identities — "Amber" claimed capture, preservation, grading, *and* routing, while Feed ran its own grade/route stages. The carving above is the fix: the pipeline stages Feed runs (summarize, rate, route) are conceptually Synapse's work executed in Feed's plumbing.

---

## The One Loop

**The order is load-bearing: preservation happens at capture, not at the end.** The raw signal is written to the amber ledger the instant it's caught, unconditionally, before any grader can reject it or any router can drop it. Write-ahead-log semantics: nothing entering Synapse is ever lost, even if everything downstream fails.

```
             ┌───────────────────── RESURFACE ─────────────────────┐
             │        search · Pulse /synapse · promote            │
             ▼                                                     │
  CAPTURE ─→ JOURNAL ──────→ GRADE ────→ ROUTE ──┬─→ KNOWLEDGE idea-note (all)
  (inputs)   amber ledger    score vs   where    ├─→ work issue Type:queue / Type:project
             D1: append-     TELOS      to?      ├─→ Upgrades review queue
             only, dedup,                        ├─→ Blog-seed queue
             never deleted                       └─→ Questions queue

  inputs: summarize hotkey · bookmarks · voice markers · feed · reader extract · manual · gesture*
```

- **Capture** grabs the raw thing with the least possible friction.
- **Journal** writes it to the amber ledger *immediately and unconditionally*. Everything downstream operates on a record that already exists.
- **Grade** summarizes and scores it — not "is this good?" but "is this good *for what the principal is doing?*" (TELOS). In some components grade and route are fused into one call; the stage split is the conceptual model, not always a separate worker.
- **Route** answers the question that used to be manual: where does this belong? It fans the signal to the destinations it earns.
- **Resurface** is the other half of preservation: a signal journaled and never dug back out is a write-only archive. Recall is part of the contract — search, the Pulse surface, and the Cortex note every non-quarantined capture gets.

---

## Inputs (the capture surfaces)

Everything that can drop a signal into Synapse. Each is real unless marked `roadmap`. Component names are LifeOS-internal; exact hosts/URLs are in the instance ISA.

| # | Input | Trigger | LifeOS component | Status |
|---|-------|---------|------------------|--------|
| 1 | **Summarize hotkey** | browser hotkey on any page | a Workflows summarization action | live |
| 2 | **Bookmarks → idea-issues** | bookmark sweep (`tb`) | the X bookmarks skill → `Type:queue` work issues | live |
| 3 | **Bookmarks → summarize (cloud)** | hourly cron | Workflows bookmark-summarize worker → sheet | live |
| 4 | **Harvest → Knowledge** | the harvest intent on a URL/video/text (`/ha` where that private skill is installed; not shipped) | the harvest skill → Workflows harvest + classify workers | live |
| 5 | **Voice markers** | "begin idea … end idea" on the wearable | the lifelog skill's idea sweep → email → blogging | live (extract loop scheduled) |
| 6 | **Feed pipeline** | RSS/YouTube/social source polling | the Feed project | live (rules engine designed) |
| 7 | **Reader extraction** | the reader curates + extracts ideas | the reader app | live (extraction sparse) |
| 8 | **Report-only mine** | the harvest Mine intent for LifeOS-system usefulness (private skill; not shipped) | the harvest skill's Mine intent | live (feeds decisions, not the store) |
| 9 | Reader upvote → capture | thumbs-up on a reader item | — | **roadmap** |
| 10 | Gesture / wearable ad-hoc trigger | a physical trigger from anywhere | — | **roadmap** |
| 11 | Email → capture (via assistant) | forward to a capture address | partial | **roadmap** |

Adding input #12 means "wire it to the capture contract," never "invent a new pipeline." That is the entire payoff of having a named router.

---

## The Capture Contract (what every input plugs into)

**Every capture, from any input, is one record:**

| Field | Required | Meaning |
|-------|----------|---------|
| `source` | yes | which input produced it (`summarize-hotkey`, `x-bookmark`, `lifelog`, `feed`, …) |
| `external_id` | yes | the input's own id for the item — half the dedup key |
| `url` | url **or** content | normalized source URL |
| `content` | url **or** content | raw text/transcript when there's no URL |
| `captured_at` | yes | when it entered Synapse |
| `content_kind` | yes | `article` \| `video` \| `tweet` \| `paper` \| `note` \| `tool` \| … |
| `title` / `author` | no | when the input knows them |
| `privacy_class` | yes | `public` \| `personal` — gates the local→cloud flow |

**Contract behavior (non-negotiable):**

- **Write-ahead.** The record hits the amber ledger *first*, unconditionally, before grading.
- **Idempotent.** Dedup identity = normalized `url` + content hash (falling back to `source`+`external_id`). The same item arriving via three inputs is one ledger row.
- **Async downstream.** Grade and route run after the write, off the capture path — capture never blocks on a model call.
- **Privacy-gated.** A `personal` record never crosses to cloud storage without an explicit rule.

---

## The amber ledger (the journal)

### Source fidelity through Cortex

The extracted source is sent to the ledger before summary generation or downstream delivery. Cortex notes retain that source verbatim in a separate `Preserved Source` section; classification, relevance scores, and optional analysis cannot replace or truncate it. Short quotes and aphorisms are complete captures in their own right. Missing source text leaves routing pending rather than producing a successful title-only note.

Historical X notes can be repaired with the router's `--repair-sources` option (`--only-unanalysed` restricts the sweep; `--id=<capture-id>` selects specific records). Repair adds source text while retaining existing metadata and analysis, and creates no work items or other downstream actions. Unavailable sources remain explicitly unresolved. The router's source-preservation tests and the summarizer's capture tests exercise these contracts.

The append-only D1 ledger is the **source of truth** for everything ever captured — including grade-rejects. It is the one part of the old system name that survives, because the metaphor names exactly its guarantee: caught in amber, preserved perfectly, forever.

- Every capture persists the instant it's caught, before grading, independent of any downstream consumer.
- Raw rows are immutable; grading/routing enrich, never rewrite.
- Grade versions are stored next to scores, so historical grades stay interpretable as TELOS evolves.
- KNOWLEDGE `idea` notes are built FROM the ledger, never a parallel history. The ledger is authoritative; each note carries the originating capture id (`source_amber_id`).
- Every capture lives in the ledger forever, a low-scoring one included. The classification decides only which further destinations (issue, upgrade queue, inbox queue) it earns; the Cortex note is unconditional except for quarantined captures.

---

## Grade (setting the weight)

The graders turn raw content into a summary + a score. Synapse's job is to make them speak a common grade shape, not to replace them.

| Grader | What it scores | Home |
|--------|----------------|------|
| **summarize scorer** | category + `SCORE:` + extracted URLs | the Workflows summarize worker |
| **TELOS classifier** | 10-way classification + confidence, grounded in MISSION/GOALS/PROBLEMS/STRATEGIES | the Workflows harvest-classify worker |
| **reader label+rate** | quality tier + main/supporting ideas | the reader app's worker |
| **Feed label+rate** | `quality_score` 1–100 + labels | the Feed project + Workflows |

The TELOS classifier is the important one for routing — it's the only grader that asks *"good for what the principal is trying to do,"* not just *"good."*

Synapse grade: integer 0–10 (the amber router asks for and clamps to that range). (public issue #2244, @mj-deving)

---

## Route (propagating what clears the bar)

The routing brain grades every capture into one of eleven routes, each carrying `routed_actions`:

```
knowledge | learning | help_understand | project_integration | tech_upgrade |
telos_modification | work_item | reminder | blog_seed | question | none
```

Routing rules: the classification picks the lane, not a score cutoff. `work_item` opens a `Type:queue` work issue, `project_integration` a `Type:project` issue and `reminder` a `[Reminder]` issue; `tech_upgrade` and `telos_modification` enter the Upgrades review queue and are never auto-applied; `blog_seed` and `question` append one line to their inbox queues. Every non-quarantined capture also becomes a Cortex note: knowledge-class and security-critical items get a full analysis pass, everything else a link-and-summary note that carries the score. Each delivery dedups on the capture id and is recorded on the ledger row as a typed `routed_refs` entry. A security-critical capture is also judged against the stack manifest and registered with Achilles. A capture whose source reads as instruction-shaped is quarantined: it stays in the ledger and produces no note, issue or queue entry.

Two flags sit beside the class, because one class cannot say everything a capture is. `project_idea` marks a project, tool, repo, model, SDK or technique we could build or build with: `core` (squarely in the principal's work) opens a `Type:project` issue labelled `Priority:P1`, `adjacent` one labelled `Priority:P2`, whatever the class, with a short pitch in the body. News of an incident or event is never a project. `quote` carries the exact words of a quotable line, which append to the quotes queue. Before router v7 the class alone decided, and a bookmarked project almost always landed as knowledge or an upgrade: 1 of 60 recent bookmarks became an issue. `route.ts --regrade --id=<capture>` re-checks routed captures for these two lanes only, merging into their existing refs.

### Destinations

| Destination | What it's for |
|-------------|---------------|
| **KNOWLEDGE `idea` note** | every non-quarantined capture, built from its ledger row: a full analysis for knowledge and security items, a link and summary for the rest. Aging `inbox → seedling → budding → evergreen` |
| **work issue `Type:queue`** | captured idea — needs triage |
| **work issue `Type:project`** | an idea big enough to build |
| **Upgrades review queue** | `tech_upgrade` and `telos_modification` captures, queued for review and never auto-applied |
| **Inbox queues** | `blog_seed` (an idea worth writing up) and `question` (a deep, longitudinal question for the Socrates lane), one line each in `INBOX/blog-seeds.md` and `INBOX/questions.md`; the `quote` flag appends the exact words to `INBOX/quotes.md` |
| **Newsletter sheet** | every capture through the summarize path (hotkey, bookmark cron) is appended to the newsletter sheet by the summarize worker before routing; the bookmark watchdog reports its health |
| **Feed source registry** | roadmap: the router has no lane that adds a signal's source as a monitored feed |

---

## What Synapse Is NOT (the boundary)

| System | Job | Relationship to Synapse |
|--------|-----|-------------------------|
| **Conduit** | senses *you* — attention, commits, sessions | an internal sense; its record feeds Cortex/TELOS, not the ledger |
| **Feed** | polls sources, normalizes the outside world | the external sense; its rate/route stages are Synapse's work in Feed's plumbing |
| **The reader** | curates the incoming stream; deletes items after ~5 days | an **input**, and the case-in-chief for the ledger's permanence |
| **Harvest skill** (Mine intent; private, not shipped) | report-only — mines content for LifeOS upgrades | a **decision tool**, writes nothing to the store |
| **Cortex** | stores and retrieves what the system knows | the **store** Synapse promotes into; never a second router |

Synapse is the routing and orchestration layer that makes these pieces one system. It doesn't replace any of them.

---

## Surfaces

- **Pulse `/synapse`** — the live surface: a stream-first page (unified reverse-chron feed of captures, promoted notes, and bookmark issues), stats, and system documentation tabs. Backed by the Pulse synapse module (`GET /api/synapse`).
- **Statusline** — the INPUTS row under WORK shows captures in the last day and how many Synapse filed as issues, the open ideas and how many are core, and the newest core idea. Project ideas carry `Idea:core` or `Idea:adjacent`, never a Priority label, so they never count as work on the WORK row or in WorkSweep's priorities.
- **CLI** — the `amber` CLI (named for the ledger it drives) captures, lists, routes, and reports stats. A named `/synapse` skill is roadmapped in the ISA (ISC-24).

---

## Roadmap

The roadmap is criteria, not prose: the maintainer-side `LIFEOS/SYNAPSE/ISA.md` (not in the public release payload) carries every phase with the probe that would falsify it — input breadth (one gesture from every surface), content-type fidelity (transcript for video, body for articles, extracted text for PDFs), the skill, and closing the newsletter loop (ledger as source, sheet as generated view). Phases 1–2 (the ledger, auto-routing) shipped 2026-07-08 and are live-verified.

---

## Examples

### One signal, weighted and routed

A reader skimming an article hits the capture hotkey.

1. **Journal, before anything can judge it.** The raw item is written to the amber ledger immediately. The signal is now safe, even if every step after this crashes.
2. **Grade, off the capture path.** Asynchronously, a grader summarizes and scores it against what the reader is actually working on. Say it clears the bar.
3. **Route to where it belongs.** It scored well and looks build-shaped, so it opens a work issue and seeds a Knowledge note — the decision that used to happen by hand.
4. **Resurface months later.** The reader searches in plain words and the signal is right there, with its score and its links.

### The weak signal still survives

A half-formed thought grades poorly and earns no issue or queue entry. It is *not* discarded — it lives in the ledger forever, exactly as caught, and still gets a link-and-summary Cortex note carrying its score. Preservation is unconditional; only the action lanes are weighted. That's the synapse mechanic and the amber guarantee working together: weak signals don't propagate, but nothing is ever lost.

```mermaid
sequenceDiagram
    participant In as Input (hotkey, bookmark, voice, feed)
    participant L as amber ledger (append-only)
    participant G as Grader (vs TELOS)
    participant D as Destinations
    In->>L: write raw capture
    L-->>In: acked — the signal is safe now
    Note over L,G: everything below is async, off the capture path
    L->>G: summarize + score (set the weight)
    G->>D: route only if it clears the bar
    G-->>L: mark routed (raw row stays immutable)
```

---

## Cross-References

- Subsystem criteria: `LIFEOS/SYNAPSE/ISA.md` (maintainer-side per-instance state; not in the public release payload)
- Capture endpoint: `LIFEOS/USER/CUSTOMIZATIONS/WORKFLOWS/summarize/` (per-install private infrastructure — NOT in the public release payload; each install wires its own)
- TELOS-graded routing: the Workflows harvest + harvest-classify workers and the harvest skill's executor (private, release-excluded — it needs the Workflows worker and a bearer token; public issue #1991, @xmasyx)
- Knowledge Archive schema: `LIFEOS/MEMORY/KNOWLEDGE/_schema.md` in the private memory tree (kb-v3, `idea` note type; the release ships the archive README, and the schema is written on first Cortex use)
- Work System: `LIFEOS/DOCUMENTATION/Work/WorkSystem.md`
- Senses: `LIFEOS/DOCUMENTATION/Conduit/ConduitSystem.md` (internal) · `LIFEOS/DOCUMENTATION/Feed/FeedSystem.md` (external)
- Cortex (the store): `LIFEOS/DOCUMENTATION/Memory/MemorySystem.md`
- System/User boundary: `LIFEOS/DOCUMENTATION/SystemUserBoundary.md`
