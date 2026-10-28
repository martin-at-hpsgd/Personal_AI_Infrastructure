---
provenance: template
version: 1.0.0
---

# StateLog — Config

Dimension provenance and any principal-specific notes for the state journal.
The grammar, scale, and freshness windows are fixed in the skill and in
`LIFEOS/TOOLS/State.ts`; this file only explains what the dimensions mean to
you and records any conventions you want the skill to honor.

## Dimensions

All rate 1-5, higher is better, 3 is average. W, K, and A are freshness
counters (days since), reset by a bare letter.

| Letter | Dimension | What it means to me |
|---|---|---|
| H | overall | How the day is going, everything considered |
| M | mood | Emotional state right now |
| E | energy | Physical and mental energy |
| S | sleep | Last night's sleep quality |
| R | relationships | State of the people closest to me |
| F | financial | How money feels this week |
| C | overall creativity | (in your own words) |
| CF | creative freedom | (in your own words) |
| W | workout | Days since the last workout |
| K | walk | Days since the last walk |
| A | affirmation | Days since the last affirmation reps |

## Creativity pair provenance

`C` and `CF` are separate dimensions, each rated on its own. Write here where
your framing for the pair comes from, if it comes from a specific model or
practice, so the skill can explain it back to you consistently.

- **Framework:** (name the source, or "my own")
- **Notes:** (anything the skill should know when discussing the pair)

## Conventions

- **Default source:** manual. Entries inferred from events (a wearable workout, "just walked") use `--source signal` and may only reset W/K.
- **Affirmation practice file:** `LIFEOS/USER/TELOS/AFFIRMATIONS.md`. A bare `A` also bumps the streak line in its Active section. Leave this line out if you keep no such practice; `A` is then logged and nothing else changes.
- **Workout signal source:** (the device or app whose reported session counts as a workout, or `none`). Only this source may reset W without you typing it.
