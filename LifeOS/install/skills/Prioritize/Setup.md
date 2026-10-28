# Prioritize

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Prioritize/Config.json && bun ~/.claude/skills/Prioritize/Tools/Prioritize.ts digest | tail -2 · optional

## What it does

Prioritize answers "what should I work on next" from everything your LifeOS is already seeing: your open work queue, bookmarks and stories graded by Synapse, new Cortex notes, open upgrade records, live Achilles security entries, and your TELOS goals. A collector reads local copies of those sources only, fingerprints them, and does nothing if nothing changed. When something did change it makes one low-cost OpenAI call that returns a short focus summary and ranked recommendations. Each recommendation names its next action and cites real inputs; anything it cannot ground in the digest is dropped. The results show on the Pulse `/prioritize` page. It is display-only: it never creates issues, edits goals or sends messages, and you can dismiss any recommendation. It needs a running Pulse, an OpenAI key for the unattended lane, and at least one of the input sources; a source that is missing or stale is reported and the others still feed the run.

## Fill in

Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Prioritize/Config.json`. Smallest working example:

```json
{
  "lane": "low",
  "context": "Alex Example runs a small newsletter business. Prefer work that moves a stated life goal.",
  "routes": { "work": "your task tracker skill", "research": "Research" },
  "categories": {
    "work": "An open task that should be done next.",
    "research": "A question several inputs point at.",
    "content": "A post or video idea grounded in recent inputs."
  }
}
```

Every other field has a default.

| Field | Meaning |
|---|---|
| `lane` | Model tier for the call: `low`, `medium`, `high` or `max`, mapped to the OpenAI lanes in the LifeOS model registry |
| `windowDays` | How far back captures and notes count (default 3) |
| `maxAgeHours` | Regenerate even with unchanged inputs once the last result is this old (default 12) |
| `staleSourceHours` | A mirror older than this is reported as stale (default 6) |
| `budgetChars` | Size cap for the digest sent to the model (default 14000) |
| `maxRecommendations` | Cap on recommendations per run (default 18) |
| `limits` | Per-source item caps: `work`, `captures`, `knowledge`, `upgrades` |
| `context` | Two or three sentences about you and your business that steer ranking |
| `categories` | Category key to definition; the model may only use these keys |
| `routes` | Category key to the skill that owns the action. When you pick a recommendation the assistant hands its next action to that skill; a category with no route is offered as a plain next step |

The ranking rubric in the model prompt (security and P0/P1 work first, then goal leverage, then convergence, then novelty) is a default. To change it, say so in `context`, for example "Revenue work outranks everything else."

### Input sources

Prioritize reads these sources, all read-only. A missing source costs only that source: the error is recorded in the run's `errors` and the others still feed the run. The run fails only when every source is empty.

| Source | What it needs | If missing |
|---|---|---|
| Work queue | `LIFEOS/PULSE/state/work-cache.json`, a JSON file you or your Pulse module write (shape below) | The whole work source errors, security entries included, because both share it; the other sources still run |
| Security entries | `LIFEOS/TOOLS/Achilles.ts open-crit --json` (the vulnerability registry) | A warning is recorded; open critical and high security entries do not appear |
| Captures | Pulse `/api/synapse` on a running Pulse (`PULSE_URL` to change the address) | The capture source errors; the rest continue |
| Knowledge notes | `LIFEOS/TOOLS/KnowledgeQuery.ts` | The knowledge source errors; the rest continue |
| Upgrade records | `LIFEOS/TOOLS/Upgrades.ts` | The upgrade source errors; the rest continue |
| Goals | `LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md` with goals numbered G0, G1, ... and `LIFEOS/TOOLS/WorkSweep.ts` (its `parseActiveGoalsFrom` reads them) | No goals appear, so goal-leverage ranking has nothing to use |

The work queue file looks like this. Only open items outside the `Complete` column are read.

```json
{
  "fetchedAt": "2026-01-01T00:00:00Z",
  "issues": [
    {
      "number": 12,
      "title": "Draft the March issue",
      "state": "OPEN",
      "column": "In Progress",
      "labels": ["Priority:P1", "goal:G2", "Type:Content"],
      "updatedAt": "2026-01-01T00:00:00Z",
      "url": "https://example.com/issues/12"
    }
  ]
}
```

`Priority:P0` to `Priority:P3` labels set the sort order, `goal:G#` labels link an item to a goal, and `Type:` labels show as the kind. Without this file there is no work queue source.

The security entries come from the vulnerability registry. Its `work_issue` field is that registry's own schema field for the linked issue number; Prioritize shows it as "issue #N" and does not write it.

The state Prioritize writes is under `LIFEOS/MEMORY/STATE/prioritize/` and the tool creates it.

## Accounts and secrets

- An OpenAI API key in `~/.claude/.env` as `OPENAI_API_KEY_OPTIN`, which `Inference.ts` uses for unattended work. Get it from your OpenAI account's API keys page.
- Pulse running locally. The default address is `http://localhost:31337`; set `PULSE_URL` to change it.
- To refresh every two hours, schedule `bun ~/.claude/skills/Prioritize/Tools/Prioritize.ts run` every 120 minutes with the scheduler your LifeOS uses. It exits 0 on a deliberate skip.

## Prove it works

```bash
bun ~/.claude/skills/Prioritize/Tools/Prioritize.ts digest | tail -2
```

This prints the exact digest the model would see. It makes no model call and spends nothing. A working install ends with a blank line and then a line of this shape:

```
fingerprint <32 hex characters> · <N> chars
```

Without `Config.json`, every command exits 1 and points at this file.
