---
name: Prioritize
metadata:
  short-description: "Ranks what to work on next from the work queue, graded bookmarks and stories, new notes, upgrade records, and TELOS goals, shown on Pulse."
version: 1.1.2
evals:
  manual:
    reason: "whether a recommendation is actually worth doing needs the principal's judgment"
    falsifier: "the principal dismisses most of a run's focus items as irrelevant or already handled"
description: Turns everything the system is seeing (open work queue, Synapse-graded bookmarks and stories, new Cortex notes, open upgrade records, TELOS goals) into ranked recommendations of what to work on, shown on the Pulse /prioritize page and refreshed every 2 hours by a cheap OpenAI job. USE WHEN prioritize, what should I work on, what should we work on next, what's most important right now, recommendations, what is the system seeing, run prioritize, refresh priorities, show priorities, why is this recommended, act on a recommendation. NOT FOR creating or triaging work issues, the upgrade queue itself (Upgrade), editing TELOS (use `Telos`), or mining one piece of content.
---

# Prioritize

Cross-system recommendation engine. A deterministic collector reads local mirrors, skips when nothing changed, otherwise makes one OpenAI call and writes grounded recommendations. The Pulse page is the primary surface; this skill is for running it on demand and acting on what it says.

## Ideal State

- What to work on comes back as a short ranked list, each item naming its next action and the real inputs behind it, with nothing invented.
- The recommendations are current: a stale `latest.json` is refreshed first, unchanged inputs cost no model call, and source errors are named rather than hidden.
- Acting on a pick goes to the skill that owns it under normal permissions; the engine itself never creates, edits or sends anything.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Run** | "run prioritize", "refresh priorities", "what should I work on" (when latest is stale) | `Intents/Run.md` |
| **Review** | "show priorities", "why is X recommended", "let's do the first one", "dismiss that" | `Intents/Review.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time install: Config.json, the OpenAI key, the 120-minute schedule |

## Data & Config

- Config: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Prioritize/Config.json` (lane, window, budget, limits, principal context, category definitions, and `routes`: which skill owns the action behind each category). Without it every command exits 1 and points at the setup guide: [Setup.md](Setup.md).
- State: `LIFEOS/MEMORY/STATE/prioritize/` (`latest.json`, `status.json`, `dismissed.json`, `history/`); override with `LIFEOS_PRIORITIZE_DIR`.
- Inputs (read-only): `LIFEOS/PULSE/state/work-cache.json` (optional; skipped with a recorded error when absent), `Achilles.ts open-crit --json` (rides in the work source), Pulse `/api/synapse`, `KnowledgeQuery.ts`, `Upgrades.ts list`, `USER/TELOS/PRINCIPAL_TELOS.md`, `TELOS.md` freshness, `LIFEOS_STATE.json`, `MEMORY/STATE/work-attention.json`.
- Pulse endpoints: `GET /api/prioritize` (page data), `POST /api/prioritize/{dismiss,undismiss,run}` (dismissal, detached forced run), at `PULSE_URL` (default `http://localhost:31337`).
- Schedule: a job that runs `Prioritize.ts run` every 120 minutes, set up with whatever scheduler your install uses; the model call goes through `Inference.ts` with an OpenAI key (Setup.md).

## Gotchas

- Synapse is read through Pulse `/api/synapse`; when Pulse is down the capture source errors and the run continues on the rest (recorded in `errors`).
- `KnowledgeQuery.ts --created-after` includes `_archive` notes; the loader filters them out.
- PRINCIPAL_TELOS goal text is truncated with "..."; goal ids (G0…) match WorkSweep's `goal:G#` labels.

## Examples

```
User: "what should I be working on?"
→ Review: read latest.json; if older than the job cadence, Run first
→ Answer with the focus summary and top three, each with its next action and evidence
```

```
User: "do the second one"
→ Review: route the recommendation's next action to the skill Config.json `routes` names for its category (a work issue, an Upgrade record, a Telos edit, a draft), under the normal permission rules
```
