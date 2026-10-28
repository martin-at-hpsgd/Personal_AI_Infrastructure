# Retire

A skill removed from LifeOS, or absorbed into another, with no capability lost, no live reference left pointing at it, and history intact.

## Ideal State

- The disposition is named before anything is touched: Retire (the capability goes away or is already covered) or Absorb (unique machinery moves to a named destination skill).
- Before anything is deleted, a capability map exists for the skill (and for each intent retired on its own): every deliverable, tool function, maintained data, unique source, trigger and consumed output in the old files, each with the file:line where it lives afterwards, or marked dead with evidence (zero recorded uses plus a never-wired path, an empty dataset, or a stub). An agent that did not write the map checks every row against HEAD, and the map holds no row that is neither placed nor proven dead.
- On an absorb, every `Tools/` and `Intents/` item with no equivalent in the destination exists in the destination before the retired skill is deleted, and the destination's description carries the retired skill's trigger vocabulary, so requests that used to route there still land.
- `skills/<SkillName>` and its release-template customization are gone.
- Every live inbound reference is gone: the inbound-reference search re-run after deletion returns nothing.
- `settings.json` was regenerated from `~/.config/LIFEOS/USER/CONFIG/settings.user.json`, both the description line and the name-only entry were updated there, and any spinner tip that names a skill count shows the new count.
- Frozen history is untouched, the current algorithm file named by `LIFEOS/ALGORITHM/LATEST` no longer claims the skill is live, and documentation lines that record what a surface used to be remain.
- `bun LIFEOS/TOOLS/IntegrityCheck.ts` reports no more blocking findings than before, and its `spinner-tips` and `ascent-vocabulary` checks pass.

## Anti-criteria

- Deleting before porting. That order is how capability gets lost.
- Accepting "covered by X" without opening X. On 2026-10-10 eight skills were retired on that claim; independent audits then found 27 capabilities with no home (stack CVE research, multi-horizon scenario testing, the sales pitch package, registry upkeep), all restored or ported afterwards.
- Treating zero recorded uses as proof a capability is dead. Usage logs miss hand runs; dead needs a second sign.
- Editing `settings.json` directly. It is generated, and the next merge wipes the edit.
- Editing frozen history: anything under `LIFEOS/LIFEOS_RELEASES/` (not in the public release), superseded `LIFEOS/ALGORITHM/v*.md` files, or `LIFEOS/ALGORITHM/changelog.md` (not in the public release). They are historical records and are never back-filled.
- Removing the user's customization data at `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/` without asking.
- Counting a hit in `projects/`, file history or `LIFEOS/MEMORY/` as a live reference to fix; those are history.

## Inputs

- The skill to retire, and on an absorb the destination skill.
- The skill's `Tools/` and `Intents/`, compared against the destination's.

## Safety gates

- Porting first. On an absorb, nothing is removed until every unique `Tools/` and `Intents/` item has a home in the destination.
- References before removal. Every live hit from the inbound-reference search is updated before the skill directory is removed.
- The user's data is theirs. Ask before removing `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/`; never sweep it with the skill.
- History stays frozen. Only `LIFEOS/ALGORITHM/LATEST`'s current version is live doctrine and gets updated; release snapshots, superseded algorithm versions and the changelog are left alone. Keep a documentation line that records what a surface used to be, and remove only the live claim.
- Removal is limited to the two paths in the tool contract below.

## Tool contract

The order is fixed: each step depends on the one before it. Every command runs from `~/.claude`.

```bash
# 1. Find live inbound references (from ~/.claude). Run before deletion and again after.
cd ~/.claude && rg -n -g '!node_modules' -g '!LIFEOS_RELEASES' -g '!projects' -g '!file-history' -g '!shell-snapshots' -g '!LIFEOS/MEMORY' -g '*.{md,json,ts,yaml,yml,sh,plist,jsonl}' "<SkillName>" .

# 2. After editing ~/.config/LIFEOS/USER/CONFIG/settings.user.json, regenerate settings.json
bun LIFEOS/TOOLS/MergeSettings.ts --system settings.system.json --user ~/.config/LIFEOS/USER/CONFIG/settings.user.json --output settings.json

# 3. Remove the skill. Never `git rm`: it stages the deletions in the
#    shared index, where a peer's commit can take them.
rm -r skills/<SkillName>
#    A LifeOS source tree also keeps a release-template customization for the skill; remove that too when it exists.

# 4. If a spinner tip in settings.user.json names a skill count, update it and re-run step 2.

# 5. Verify: blocking count must not rise; spinner-tips and ascent-vocabulary must pass. Then re-run step 1; it must return nothing.
bun LIFEOS/TOOLS/IntegrityCheck.ts

# 6. Commit everything this retirement touched in one call (deletions included); CommitOwn stages nothing else.
bun LIFEOS/TOOLS/CommitOwn.ts -m "Skills: retire <SkillName>" -- skills/<SkillName> <the destination files, reference fixes and settings.json>
```

Where live references reliably occur: `settings.json` and its real source `~/.config/LIFEOS/USER/CONFIG/settings.user.json` (both the description line and the name-only entry), `commands/` slash commands, `hooks/` including any allowlist or shape list a hook module keeps, `skills/LifeOS/GETTING-STARTED.md`, `private-maintenance-tooling-not-included/RELEASE_TEMPLATES/`, documentation under `LIFEOS/DOCUMENTATION/`, workflow definitions at `LIFEOS/USER/WORKFLOWS/*.workflow.yaml`, launchd plists and shell scripts.

## Gotchas

- `settings.json` is generated. A direct edit is wiped on the next merge; edit `settings.user.json` and regenerate. Observed 2026-09-21 during the CMUX retirement.
- The search's file globs must keep `yaml`, `yml`, `sh`, `plist` and `jsonl`, or workflow definitions, launchd plists and shell scripts that name the skill are missed.
- `settings.user.json` and `settings.json` are shared with sessions editing permissions, and may hold their uncommitted lines. Commit only your own lines in them (HEAD plus your change); never commit the whole file. Observed 2026-10-10 during the Loop absorb.
- The search excludes session transcripts (`projects/`), file history and `LIFEOS/MEMORY/` on purpose. They hold old mentions that are history, not live references. Any other hit is live and must be fixed.

## Output format

```
Retired: <SkillName>   Disposition: Retire | Absorb → <Destination>
Ported to destination: <items, or none>
Live references updated: <count and files>
User customization data: <kept | removed with the user's yes>
IntegrityCheck blocking: <before> → <after>; spinner-tips pass; ascent-vocabulary pass
Re-run search: no hits
```

## References

- New skills that supersede old ones retire them in the same motion: `Intents/CreateSkill.md` (ABSORB).
- The settings merge and the user/system split: `LIFEOS/DOCUMENTATION/SystemUserBoundary.md`.
