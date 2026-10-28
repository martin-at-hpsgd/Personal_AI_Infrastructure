# Update — signpost for installs that still read the old path

This file exists for one reader: an install from before 2026-10-08 (7.x), whose Update step re-reads `Workflows/Update.md` after the release fetch. That path was renamed to `Intents/Update.md`. The real intent is there; this signpost only carries the agent over to it.

## Ideal State

- An agent that arrives here from an older install's Update step ends on the current update sequence: the release fetch it just finished, then `bun Tools/InstallAll.ts --yes --json`, then Doctor.
- The agent reads `Intents/Update.md` before it acts, and treats that file as the only source for what the update does.
- This file holds no update logic of its own, so it cannot drift from `Intents/Update.md`.

## Anti-criteria

- Never follows any step an older copy of the Update intent listed after the fetch; those steps are replaced by the single `InstallAll.ts` command below.
- Never restarts the release fetch. Reaching this file means the new skill is already in place.

## Where to go

1. Read `Intents/Update.md` in this skill directory.
2. Continue from its step 3: from this skill directory run `bun Tools/InstallAll.ts --yes --json`, then `bun <configRoot>/LIFEOS/TOOLS/Doctor.ts`. Step 5 of that intent names the evidence the update report carries.
