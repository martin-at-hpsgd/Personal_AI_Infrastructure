---
version: 1.0.1
---

# TELOS (your goals and where you stand)

Status: `bun LIFEOS/IDEALSTATE/IdealState.ts rows` · required

## What it does

TELOS is the written form of why you do what you do: your mission, the problems you want to solve, your goals, what stands in the way, and the plan. LifeOS reads it so the assistant understands the reason behind a request, not only the request. It also measures the distance between where you are and where you want to be. The Pulse dashboard draws that as one ring per life dimension, the status line shows the same numbers.

One file is the source of truth, `LIFEOS/USER/TELOS/TELOS.md`, written as `##` sections: Current State, Ideal State, Mission, Problems, GOALS, Challenges, Risks, Strategies, Projects, Narratives and Wisdom. Two folders sit beside it. `CURRENT_STATE/` and `IDEAL_STATE/` each hold one file per dimension, with the same fixed uppercase names in both: `HEALTH.md`, `MONEY.md`, `FREEDOM.md`, `CREATIVE.md`, `RELATIONSHIPS.md`, `RHYTHMS.md` and `INFRASTRUCTURE.md`. A dimension with no file simply has no ring. The older split files (`MISSION.md`, `GOALS.md` and so on) are samples kept for compatibility; the tools use them only when `TELOS.md` lacks the matching section.

Two files here are generated and should never be edited by hand: `PRINCIPAL_TELOS.md`, a roughly 60-line summary that sessions load at startup, and `LIFEOS_STATE.json`, the percentage per dimension that the rings and status line read. A dimension whose state files are still templates reads `null`, which means not captured.

## Fill in

Start with the interview. Ask your DA to run the LifeOS interview, or type `/LifeOS interview`. After the identity questions it captures your current state (mission, the people who matter, current projects, challenges, what is true right now), then your ideal state (goals with metrics and dates where you have them, strategies, the destination), and writes them to `TELOS.md`. Its last step regenerates the two derived files so Pulse shows real data on first open. You can hand it existing notes, exports or links to pull from instead of retyping, and you can stop and resume.

To edit by hand, open `TELOS.md`, delete each `(sample)` entry and write your own under the same `##` heading. Keep entries short; the assistant reads them every session. Leave a marker such as `<!-- updated: YYYY-MM-DD by:you -->` on a section to record when you last reviewed it. In `CURRENT_STATE/` and `IDEAL_STATE/`, each file starts with a `provenance: template` line in its frontmatter. While that line is there, the file counts as "not captured". Delete the line once the file holds your real answer.

After any hand edit, regenerate the two derived files. Both write to your TELOS folder (from each tool's own header):

```bash
bun LIFEOS/TOOLS/GenerateTelosSummary.ts   # rewrites PRINCIPAL_TELOS.md from TELOS.md
bun LIFEOS/TOOLS/UpdateLifeosState.ts      # rewrites LIFEOS_STATE.json from the two state folders
```

## Accounts and secrets

None. TELOS is plain files on your machine, and a public LifeOS release never includes your `USER/` folder. Do not put account numbers, passwords or keys in it; write the goal, not the credential. Backups of bulk TELOS edits land in `TELOS/Backups/`.

## Prove it works

```bash
bun LIFEOS/IDEALSTATE/IdealState.ts rows     # one line per goal and target row it found in your TELOS files; exit 0
bun LIFEOS/TOOLS/SetupInventory.ts status    # the TELOS row should read "ready"
```

Each line of `rows` starts with an id (a dash until ids are assigned), says whether the row is bound to a measurement, and quotes the start of the goal. Your own goals should appear there. On a fresh install you will see the one `(sample)` goal from the template; seeing your own text instead means the file parsed.

Then check the derived files. `PRINCIPAL_TELOS.md` should summarize your mission and goals in your words, and `LIFEOS_STATE.json` should hold a number for each dimension whose state files you filled in (`null` means not captured). The rings appear in Pulse, at `localhost:31337`, once the dashboard is running.

The daily measurement pass (`bun LIFEOS/IDEALSTATE/IdealState.ts reconcile`) writes its own state folder, so it is not a read-only check. Until it has run once, `bun LIFEOS/IDEALSTATE/IdealState.ts gap` prints "no reconcile yet" and exits 1. That is expected, not a fault.
