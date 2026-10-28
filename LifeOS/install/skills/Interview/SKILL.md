---
name: Interview
evals:
  manual:
    reason: "current-state and TELOS corrections require the principal's ratification against personal evidence"
    falsifier: "the principal rejects a proposed correction as unsupported, stale, or wrongly scoped"
metadata:
  short-description: "Refresh TELOS and current/ideal state through an evidence-grounded interview; ratify corrections and configure fresh installs. Use Telos for single edits."
version: 1.2.4
description: Refreshes TELOS and current-state claims against observed evidence (Oura, Conduit, git, expenses) and drafts corrections for ratification. USE WHEN /interview, resume interview, context check-in, telos check-in, what's stale, stale data, freshness check, update current state, update my current state, state sync, statusline says interview due, interview due, review TELOS, update ideal state, quarterly context refresh, fresh LifeOS install, configure DA name. NOT FOR single edits (Telos), bulk intake (Migrate), identity-only.
---

# Interview — constitutional-context peer conversation

Interview reads your constitutional files — TELOS, identity, projects, system prompt, architecture — plus the CURRENT_STATE and IDEAL_STATE dimension files, checks their freshness, and confronts stale claims with observed data: Oura sleep/HRV/RHR, Conduit creation-vs-consumption time, the work registry, git cadence, and the expense ledger. The conversation opens with the sharpest claim-vs-evidence contradiction, drafts corrections you ratify, offers to populate the files the machinery can write, and closes with an ideal-state review grounded in the measured gap. On a fresh install it falls back to first-time setup. The 🎤 statusline chip (fed by `InterviewDue.ts`, daily launchd refresh) says when one is due; wrapping with `--mark-done` clears the cadence reason, and the skew/staleness reasons clear as their files are actually reviewed.

## Ideal State

- Every prompt argues from what is already on file and from observed data: the files are read first, and a claim is checked against evidence or named as unchecked, never replaced by a blank "what's your mission?".
- Staleness is treated as a priority signal, not a failure: the conversation leads with the sharpest contradiction or the stalest item and asks "still right?".
- Nothing in a claims file changes without the principal ratifying that specific edit, and every reviewed item leaves its freshness marker bumped, so the 🎤 chip clears only when the agenda is actually done.
- A fresh install is configured end to end (identity, voice, credentials, first project, work repo) before any check-in runs.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **ContextCheckin** | default `/interview` on a populated system; "context check-in", "telos check-in", "what's stale", "how are we doing on…", "still on…", "review context" | `Intents/ContextCheckin.md` |
| **Phase0Setup** | fresh install; `LIFEOS_CONFIG.toml` still holds the scaffold names (DA `Aria`, principal `Your Name`); PROJECTS sample-row only; `.env` missing required keys | `Intents/Phase0Setup.md` |
| **TelosCheckin** *(deprecated stub)* | back-compat for explicit "telos checkin" routing | `Intents/TelosCheckin.md` (redirects to ContextCheckin) |

| File | Read when |
|------|-----------|
| `ISA.md` | changing how the interview works: the skill's own ISA (evidence-grounded state freshness); `ISA.html` is its rendered page |
| `Setup.md` | first-time setup: the optional PREFERENCES.md key and a read-only proof |
| `References/ContextCheckinExamples.md` | shaping a ContextCheckin opening or per-entry prompt and wanting a worked run (stale system prompt, all-fresh with an audit finding, a Goals walk with its bump) |

**Routing decision (run before either intent):**

```bash
bun ~/.claude/LIFEOS/TOOLS/InterviewScan.ts --json | jq '[.targets[] | select(.phase == 0 and .completeness_score < 80)] | length'
```

- `> 0` → run **Phase0Setup** first, then ContextCheckin.
- `0` → run **ContextCheckin** directly.

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interview/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). `PREFERENCES.md` § State check-in priority names the journal dimension the wrap asks first (absent: equal weight). `History.md`, when present, holds this install's own interview history; it is reference, never read at run time. First-time setup and every key: [Setup.md](Setup.md).

## Gotchas

- **The current.json day-label trap.** `USER/HEALTH/current.json` labels itself with today's `day` while its `last_night` block may carry the newest *available* sleep record, days older. Quote the evidence cache's `latest_sleep_record_day`, never the label.
- **Not every health source is live.** The evidence panel (`StateEvidence.ts`) computes per-source liveness at run time — quote its live/dead map, never a remembered one. Claims whose only source is dead can be asked, not checked — say so instead of implying verification.
- **`InterviewDue.ts --mark-done` at wrap is what silences the 🎤 statusline chip.** Skipping it leaves the chip nagging with the interview already done — the cadence clock reads `MEMORY/STATE/interview.json`, not file mtimes.
- **A file without the freshness frontmatter reads as stale.** TELOS and the constitutional files each need a one-time migration first; the commands and the ask-first rule are in `Intents/ContextCheckin.md` § Safety gates.
- **The slug is normalized:** "Current State" → `current_state`, "Wrong (Things I've been wrong about)" → `wrong`, "2036 — A Day in the Life…" → `2036`. Always run heading text through `sectionSlug()` from `TelosFreshness.ts`.
- **Pulse caches freshness for 60s.** After bumping, the next `/api/telos/freshness/summary` call returns the cached value until invalidation. `POST /api/freshness/invalidate` clears it immediately, or wait 60s.
- **TelosRenderer (`GenerateTelosSummary.ts`) preserves the markers.** It splits by `^## ` headings; the per-section HTML comments live inside the section body and are not re-emitted in `PRINCIPAL_TELOS.md`. Safe to run after edits.
- **The scanner shares the freshness reader.** `InterviewScan.ts` calls `readTelosFreshness()` once at startup and adds `age_days`, `threshold_days`, `stale` to every Phase 1+ target row. Stale sections get a +200 priority bump so they naturally rise in `--next` output.
- **Voice notifications are "only on actual writes."** Don't voice-confirm every prompt — only after a real Edit lands. The voice channel is a low-frequency signal; preserving that is what makes it land when it matters.

## Examples

- "/interview" on a populated system → routing probe via `InterviewScan.ts`, then ContextCheckin walking the stalest sections first ("G2 is 95 days old — still right?").
- "what's stale?" → freshness summary from TelosFreshness, prioritized list, no edits unless approved.
- Fresh install (DA name still the scaffold `Aria`, PROJECTS sample-row only) → Phase0Setup first, then ContextCheckin.

## Related

- `/Telos` — edit a single TELOS section directly (without the conversational walk).
- `/Migrate` — intake content from other sources (one-shot classification, not an interview).
- an identity-profile skill — manage PRINCIPAL_IDENTITY directly.
- `Skill("ISA")` — interview an ISA (different artifact, different intent).
