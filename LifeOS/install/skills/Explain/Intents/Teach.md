# Teach

Run an interactive, voice-narrated tutorial on the current topic. The session is a dialogue the learner drives by answering; it is done when the ideas have been talked through, not when the material has been printed.

## Ideal State

- The lesson teaches the topic the learner meant (§ Inputs); when several topics are live, it first asks one "Teach you X, or Y?" question.
- The session is a dialogue the learner drives by answering, and it ends when the ideas have been talked through, not when the material has been printed; the outcomes below are met in whatever order the dialogue takes.
- The learner hears the actual content spoken aloud: the teaching itself, not status narration about teaching.
- Every concept has a visual: an ASCII diagram carrying real structure (flow, hierarchy, comparison, timeline), not decoration.
- The learner answers a question on every beat and gets a genuine response to their own answer (confirm, sharpen, or correct, quoting their words, never a canned "correct!"), and the next beat builds on it.
- A misconception surfaced by a wrong answer is re-taught from a different angle before the lesson moves on.
- Near the end, a short quiz (2-3 questions) tests the whole arc, each answer responded to individually.
- The session closes with a spoken recap and one final ASCII map of everything covered.
- The learner ends it satisfied: "got it", "stop", or a clean quiz.
- The lesson covers 3-5 concepts; when there is more material than that, the learner is told so and offered a part two.
- Each beat stays small: one idea, one diagram, one question. A beat needing two diagrams is two beats.
- Difficulty tracks the learner's answers: strong answers earn depth and edge cases, misses earn simpler framing.

## Anti-criteria

- Never invents a topic: a fresh session with no topic and no argument gets asked what to teach.
- Never answers its own question and keeps going: a beat ends at its question and the turn stops there, because continuing turns the tutorial back into the lecture this skill exists to prevent.
- Never grades on a curve of politeness: a wrong answer gets named wrong, kindly.
- Never puts markdown, code, symbols, or ASCII in the spoken narration, and never restates the narration in the `🗣️` closer.

## Output format

Every tutorial turn renders, in order:

1. The narration curl (fired first, silently).
2. A short prose version of the teaching point (2-3 sentences — the readable twin of what was spoken, not a transcript).
3. The ASCII diagram in a code fence. The learner's terminal renders monospace: diagrams fit 80 columns, ~20 lines max.
4. Exactly one question to the learner — comprehension check, prediction ("what happens if..."), or quiz item.
5. The turn ends there. The question is the last substantive content; the learner's answer drives the next beat. In LifeOS-formatted environments the `🗣️` closer carries the question so it is spoken too.

### Quiz Protocol

- Fires near the end of the arc, or immediately on "quiz me".
- 2-3 questions, one per turn, drawn from the beats actually taught — application over recall where possible ("given X, what breaks?").
- Each answer gets an individual verdict and a one-line why. Two misses on the same concept → re-teach that beat differently before the next question.
- After the last answer: spoken recap + final ASCII map of the full arc + honest read on what stuck and what to revisit.

### End Conditions

Stop immediately and recap when the learner says stop/done/got it; finish normally after the quiz; offer part two if concepts were deferred.

## Inputs

Default topic = whatever this conversation has been working on or asking about. An explicit argument ("/teach-me OAuth refresh tokens") overrides it. A clear topic is announced and the lesson starts.

## Tool contract

At the start of every tutorial turn, POST the beat's narration to the voice endpoint (fire-and-forget):

```bash
VOICE=http://localhost:31337   # Pulse VoiceServer, desktop channel
curl -s -m 5 -X POST "$VOICE/notify" \
  -H "Content-Type: application/json" \
  -d '{"message": "NARRATION"}' \
  > /dev/null 2>&1 &
```

`NARRATION` rules:
- The actual teaching for this beat in conversational spoken English, 1-3 sentences, ≲350 characters.
- Plain speech only: no markdown, code, symbols, or ASCII — TTS reads them literally. Spell out anything a voice would say differently ("H T T P" reads better than "HTTP" for some engines; when unsure, rephrase).
- One curl per turn. Never batch several beats into one message or one turn into several curls: multiple rapid POSTs queue and overlap into noise, and long messages become a synthesized wall. A beat that needs more speech than that is too big — split it.
- When responding to a learner's answer, the narration is the response to their answer ("Right — and here's the part most people miss...").
- Non-200 or refused: continue text-only for the rest of the session, note it once at session start; do not retry every beat.

## Gotchas

- **The completion hook already speaks the `🗣️` closer line.** Never repeat the beat's narration in the closer or the learner hears it twice. The intended shape: the narration curl speaks the teaching, the closer carries the question — two distinct voice moments per turn.
- **The narration curl was stripped by the 2026-10-09 voice-block codemod (e157e0bd0)** along with the retired "Running the..." notifications; it is the lesson's spoken content, not a status line, so it stays here. IntentLint's `voice-curl` rule matches the joined host-and-path literal, so the host sits in `$VOICE`.
