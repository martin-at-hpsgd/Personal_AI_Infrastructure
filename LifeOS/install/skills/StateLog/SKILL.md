---
metadata:
  short-description: "Log mood and state shorthand such as M4 or e4 cf3, workouts, walks, and affirmations. Use Telos for life-gap scores and Vitals for Mac performance."
name: StateLog
evals:
  suites: [state-shorthand]
version: 1.2.2
description: State journaling from shorthand like M4, H2, CF5 (H overall, M mood, E energy, S sleep, R relationships, F financial, C creativity, CF creative freedom, W workout, K walk, A affirmation) on 1-5, with freshness resets. USE WHEN a message is only dimension shorthand (M4, e4 cf3, W, K, A), log my state, log my mood, state check-in, how am I tracking, just worked out, went for a walk, did my affirmations. NOT FOR life-goal percentages (use `Telos`), health imports, macOS stats (Vitals).
---

# StateLog

**Contents:** Ideal State · Intent Routing · The grammar · Data & Config · Tool contract · Gotchas · Examples

Two keystrokes to a durable journal entry. The user sends `M2` on any channel; it lands timestamped in the state log and the statusline reflects it. The point is zero-friction capture of mood and state so correlations (mood vs sleep vs workouts) become computable later.

## Ideal State

- Every entry the user states lands in the log in one tool call and gets one short acknowledgment, with no follow-up questions or analysis.
- Ratings come only from the user's own words; inferred events reset freshness counters and never write a rating.
- A status read shows each dimension's latest value and age, and names what is stale or never logged in one line.
- The journal stays the user's: it lives under `LIFEOS/USER/STATE/` and never enters this skill or any public artifact.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Log** | A shorthand entry, "log my state/mood", "just worked out", "went for a walk" | `Intents/Log.md` |
| **Status** | "current state", "state check-in", "how am I tracking" | `Intents/Status.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup, or `Config.md` is missing |
| `EvalState.md` | checking the `state-shorthand` eval suite's latest scores (machine-owned, never hand-edited) |

## The grammar

`<Letter><Digit 1-5>` plus optional note (`M2 slept badly`). Bare `W` or `K` resets that freshness counter.

| Letter | Dimension | Kind |
|--------|-----------|------|
| H | overall | rating 1-5 |
| M | mood | rating 1-5 |
| E | energy | rating 1-5 |
| S | sleep | rating 1-5 |
| R | relationships | rating 1-5 |
| F | financial | rating 1-5 |
| C | overall creativity | rating 1-5 |
| CF | creative freedom | rating 1-5 |
| W | workout | freshness (days-since) |
| K | walk | freshness (days-since) |
| A | affirmation | freshness (days-since) |

Scale (star-rating semantics, higher is better): 1 really bad · 2 bad · 3 fine (shown yellow, never treated as a crisis) · 4 and 5 the preferred range (shown green). The parser clamps 0/6-9 into range and preserves the raw value. Every dimension reads the same direction — there are no inverted dimensions.

## Data & Config

What each dimension means to the user, where the creativity pair's framing comes from, the affirmation practice file, and the workout signal source: `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StateLog/Config.md` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). First-time setup is in [Setup.md](Setup.md). Read it when discussing the creativity pair, logging an `A`, or deciding whether an event counts as a workout signal. Logging itself works without it; when Config.md is missing, say so once, point the user at `Setup.md`, skip the streak bump and signal resets, and still log the entry. The letters and 1-5 scale are the tool's defaults in `State.ts`; Config.md only records what they mean to the user.

## Tool contract

The deterministic engine is `~/.claude/LIFEOS/TOOLS/State.ts` (cross-consumer: statusline, interview, this skill):

```bash
bun ~/.claude/LIFEOS/TOOLS/State.ts log "M4"              # rate
bun ~/.claude/LIFEOS/TOOLS/State.ts log "M2 rough day"    # rate + note
bun ~/.claude/LIFEOS/TOOLS/State.ts log "W"               # freshness reset
bun ~/.claude/LIFEOS/TOOLS/State.ts log "H5" --source interview
bun ~/.claude/LIFEOS/TOOLS/State.ts reset W               # signal-driven reset
bun ~/.claude/LIFEOS/TOOLS/State.ts current [--json]      # snapshot with freshness tiers
bun ~/.claude/LIFEOS/TOOLS/State.ts statusline            # compact segment
bun ~/.claude/LIFEOS/TOOLS/State.ts rebuild               # re-derive current.json from log
```

Data: `LIFEOS/USER/STATE/log.jsonl` (append-only) + `current.json` (derived). The statusline reads `current.json` directly with jq — never spawn the tool from render paths.

## Gotchas

- A bare rating letter with no digit (`M`) is an error, not a default — only W/K/A accept bare-letter resets.
- Bare `A` = "did today's affirmation reps". Config.md names the practice file (`Affirmation practice file`); on an `A` entry, also bump the streak line in that file's Active section. With no practice file configured, log the `A` and touch nothing else.
- `--source` records where an entry came from, for later correlation: `manual` (default), `interview`, `signal`. `reset W|K` stamps `signal` itself, so an entry inferred from an event ("just worked out") goes through `reset` (Intents/Log.md), never through `log` with a hand-passed source.
- Freshness is per-dimension, three tiers (fresh/aging/stale) with windows declared in `State.ts` `DIMENSIONS`: mood and energy decay in hours, relationships and financial in days. `State.ts current` computes each tier; a stale dimension is the prompt to log, not an error.
- Entries are case-insensitive, and a message may carry several at once (`e4 cf3` = energy 4, creative freedom 3). A message that is nothing but shorthand routes here silently.
- Don't route goal-percentage talk here: "health 68%" is a life-goal gap score, not a journal entry.

## Examples

```
User: "e4 cf3"
→ Log intent
→ Energy 4 and creative freedom 3 are in the log; the reply is one acknowledgment line

User: "just worked out"
→ Log intent
→ The workout counter resets with source signal, and no rating is written

User: "how am I tracking"
→ Status intent
→ A snapshot of each dimension's value and age, closing on one line that names what is stale
```
