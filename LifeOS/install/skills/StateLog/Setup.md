# StateLog

Status: bun ~/.claude/LIFEOS/TOOLS/State.ts current · optional

## What it does

StateLog turns one-line shorthand into a durable, timestamped journal of how you are doing. Send `M4` for mood 4, `e2 slept badly` for energy 2 with a note, or a bare `W` after a workout; each lands in an append-only log, and your statusline or dashboard can show the latest value and how stale it is. The point is cheap capture now so you can compare mood, sleep and workouts later. It needs only the state tool that ships with LifeOS; the config file is optional and only records what the dimensions mean to you.

## Fill in

Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StateLog/Config.md`. Smallest working example:

```markdown
---
version: 1.0.0
---

# StateLog — Config

## Creativity pair provenance

- **Framework:** my own
- **Notes:** (anything the assistant should know when discussing the pair)

## Conventions

- **Default source:** manual
- **Affirmation practice file:** LIFEOS/USER/TELOS/AFFIRMATIONS.md
- **Workout signal source:** Example Band app
```

| Field | Meaning |
|---|---|
| `Framework` | Where your framing of the creativity pair comes from, so the assistant explains it back consistently |
| `Notes` | Anything the assistant should know when discussing the pair |
| `Default source` | Label stored with entries you type yourself (`manual`) |
| `Affirmation practice file` | The file whose streak line a bare `A` bumps; leave the line out if you keep no such practice |
| `Workout signal source` | The device or app whose reported session may reset the workout counter without you typing it; `none` if you have no such source |

The letters and the 1-5 scale are the tool's defaults: H overall, M mood, E energy, S sleep, R relationships, F financial, C creativity, CF creative freedom, plus freshness counters W workout, K walk, A affirmation. The journal itself, `LIFEOS/USER/STATE/log.jsonl`, is created by the tool on your first entry; never edit it by hand.

If you keep an affirmation practice, create `LIFEOS/USER/TELOS/AFFIRMATIONS.md` with an `## Active` section and a line starting `Streak:`; the assistant bumps that line on every `A`.

## Accounts and secrets

None. If you name a wearable as the workout signal source, whatever connects it to LifeOS keeps its own credentials; nothing for this skill goes in `~/.claude/.env`.

## Prove it works

```bash
export LIFEOS_STATE_DIR="$(mktemp -d)"
bun ~/.claude/LIFEOS/TOOLS/State.ts log "M4 first entry" && bun ~/.claude/LIFEOS/TOOLS/State.ts current
unset LIFEOS_STATE_DIR
```

`LIFEOS_STATE_DIR` points the tool at a throwaway folder, so this writes nothing to your real journal. On its own, `bun ~/.claude/LIFEOS/TOOLS/State.ts current` only reads, and prints `no state logged yet` until your first entry. With the scratch folder the two commands print exactly this:

```
M4 logged (mood)
H  overall       —
M  mood          4 (0h ago)  [fresh]  — first entry
E  energy        —
S  sleep         —
R  relationships —
F  financial     —
C  overall creativity —
CF  creative freedom —
W  workout       —
K  walk          —
A  affirmation   —
```

`—` means never logged. Then tell the assistant `e3` in chat; it should reply with a single short acknowledgment and nothing more.
