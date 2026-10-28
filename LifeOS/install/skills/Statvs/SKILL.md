---
name: Statvs
version: 1.0.1
description: "Front door to STATVS (said status), the one append-only record of what happened across LifeOS and every app it runs: checks the record's health, says whether a system, app or site reports into it, writes rows, answers what happened, rebuilds and drills views, rewinds and replays past turns, and onboards a system through the five-step migration. USE WHEN statvs, status logging, status record, the record, is X logging to status, is my site reporting into status, full status logging, log this to status, write a status row, what happened, status tail, verify the record, status counters, drill, restore drill, rebuild a view, compare a view, rewind a turn, replay a miss, onboard X into status, migrate X to statvs, dual-write, register a stream. NOT FOR session status or why is this slow (the s shortcut), posting Vigil events or deciding what to text the principal (Vigil), complaints (Errata), memory recall (Cortex)."
metadata:
  short-description: "Check, query, write to and onboard systems onto STATVS, the one append-only record of state for LifeOS and its apps, said status."
evals:
  deterministic:
    - command: "bun LIFEOS/STATVS/Statvs.ts verify --json"
      falsifier: "prints ok:false with a non-empty problems list when any segment's hash chain, seal or anchor fails"
---

# Statvs

STATVS (Roman spelling, said "status") is the one record of what happened across LifeOS and every app it runs. Things that happened are appended once as rows and never rewritten; every other piece of state is a view folded from those rows that can be deleted and rebuilt. When the principal says "status logging", "the record" or "is X reporting into status", this skill is what they mean, and every intent here answers from the record and its CLI, never from a system's private log. Shared facts the intents rely on:

- **Concept:** `LIFEOS/DOCUMENTATION/Statvs/StatvsSystem.md`. **Criteria and build state:** `LIFEOS/STATVS/ISA.md` (maintainer-side; may be absent on an install). **Engine:** `LIFEOS/STATVS/` with CLI `Statvs.ts`, `Rewind.ts`, and the stream registry `streams.ts`.
- **Row shape:** one envelope (`id`, `seq`, `hlc`, `ts`, `writer`, `stream`, `class`, `app`, `kind`, `severity`, `title`, `session`, `ref`, `data`, chain fields). An append to a stream not in `streams.ts` is refused.
- **Privacy classes** (`public`, `system`, `personal`, `customer`) are the first directory of every segment and never share a file. Secret-shaped values are refused at the writer; tenant content never enters the record.
- **Reporting in** means rows from that system are landing in the record under its own `writer`, on registered streams, today. A system that only writes its own log, or only reaches Vigil through an adapter, is not reporting in.
- **Migration** happens one system at a time in five steps: dual-write, build the view from each store, compare until equal, switch every reader, delete the old store. A system has moved only when its old store is gone.
- **Neighbors:** Vigil is the advocate that reads the record and decides what to tell the principal; its `writeEvent` path also lands rows in the `event` stream, so posting a notice-worthy event stays a Vigil job. Cortex curates what is worth remembering. The bare `s` / "status" shortcut is session status, not STATVS.

## Ideal State

- Every answer about the record, a system's coverage or what happened is grounded in output from `Statvs.ts` or `Rewind.ts` run this turn, and names the command it came from.
- "Is X reporting into STATVS" always gets a yes, partial or no verdict per required stream (at least deploy and app-health for a live app), with the writer names and last row time, or the absence, as evidence.
- Nothing the skill does weakens the record: no edit to a segment, no prune of a `forever` stream, no deleted old store before its view compares equal and the restore drill passed that day.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Status** | "statvs status", "is the record healthy", "verify the record", "status counters", "drill loss", "how far is the migration" | `Intents/Status.md` |
| **Coverage** | "is X logging to status", "is my site reporting into status", "full status logging for X", "what reports into statvs" | `Intents/Coverage.md` |
| **Append** | "log this to status", "write a status row", "record this in statvs" | `Intents/Append.md` |
| **Query** | "what happened", "status tail", "show the rows for X", "when did X last report" | `Intents/Query.md` |
| **Rebuild** | "rebuild a view", "compare a view", "run the drill", "restore drill", "back up the record" | `Intents/Rebuild.md` |
| **Rewind** | "rewind a turn", "replay a miss", "rebuild that turn", "prove the fix on the old failure" | `Intents/Rewind.md` |
| **Onboard** | "onboard X into status", "migrate X to statvs", "make X report into status", "register a stream", "dual-write X" | `Intents/Onboard.md` |

## Gotchas

- **`drill` loss counts every unclaimed STATE file, not lost data.** A large loss number is mostly files under `MEMORY/STATE/` that no registered view claims yet. It measures migration distance; read `unclaimed_by_dir` and the per-view `equal` flags before calling anything broken.
- **A view marked `unmaterialized` has never been written, so it compares unequal.** `rebuild <view>` once materializes it; that is not a mismatch in the data.
- **`counters.refused` is a running total since the counters file was created, not today's refusals.** Report it as a total, and look at `tail` for what was refused recently.
- **The `event` stream is written by Vigil's `writeEvent`, not by `Statvs.ts append`.** Appending a notice-worthy row straight to `event` skips Vigil's validation and dedup; use `Statvs.ts event` or Vigil's Emit.
- **"Is it working" starts with `Statvs.ts reconcile`, not `verify`.** `verify` proves the rows that exist are intact; only reconcile finds rows that should exist and do not (missed turns, unrecorded refusals, an unshipped backlog, drifted schedules). `--hours 24` widens the window; without `--emit` it only reads. The hourly `statvs-reconcile` workflow posts each gap to Vigil.
- **The cloud record answers by default.** `tail`, `reconcile`, `tools/Coverage.ts` and `Rewind.ts` read Cloudflare through `lib/cloudRead.ts`; `--local` reads this Mac's segments until they are retired (migration ISA F9). The `rg` lines in the intents' tool contracts search the local segments and miss nothing only while those still exist. `compare-cloud --days N` proves the two agree. Cloud `tail` prints cloud rows (with `offset`, `chain`, `machine`, `srcHash`, and no `hash` or `prev`) and widens its window until it has `--n` rows. Rows of `ship: false` streams (`observe`) exist only on the machine that wrote them; the cloud holds a `local-only` marker and, once `seal-copies` has run, a sealed ciphertext copy of each row.
- **The `s` shortcut and the word "status" collide.** "Status" alone, with no mention of logging, a record, a system reporting in or STATVS, is the session-status shortcut.

## Examples

**Example 1: Is a site reporting in**
```
User: "Do we have full status logging enabled for my site?"
→ Coverage intent
→ Per-stream verdict (deploy, app-health, review) with writer names and last row times, or "no rows" for each missing one, and the Onboard step that would close the gap
```

**Example 2: Health of the record**
```
User: "Is statvs healthy?"
→ Status intent
→ verify result, counters, drill loss with what it means, and which systems sit at which migration step
```

**Example 3: Prove a fix on a past miss**
```
User: "Replay the turn behind errata 412 with the new guard"
→ Rewind intent
→ Fixture built with Rewind.ts, Assay.ts replay result saying whether the miss flipped, and which tier of proof that is
```
