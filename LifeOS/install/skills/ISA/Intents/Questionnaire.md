# Questionnaire Intent

Turns knowledge the current conversation can't reach into an async questionnaire; the live-interview counterpart is Discuss, and this is the interview that can't happen live.

## Ideal State

- The questionnaire is a standalone markdown document for someone who isn't here (a third party who holds the knowledge, or the principal answering later from another surface), written to `~/.claude/LIFEOS/MEMORY/WORK/{slug}/questionnaire-<recipient-slug>.md` in the structure under Output format, and its path is reported.
- Before drafting, the send was resolved with the principal, exactly two things, one exchange each, using the shared primitive's mechanics (`../References/Discussion.md`): who it is going to (role, expertise, relationship, which fixes tone and how much context the document must carry) and what must come back (the specific decisions or facts the principal needs to walk away able to decide).
- Every item the principal said must come back is covered by a question, and the questions are drawn from the ISA's `## Not yet specified` entries and the open flags in its `## Articulation Log` (or a legacy discussion.md in the WORK dir).
- Each question carries one idea and targets the gap between what the recipient knows and what the principal needs; the questions run most-important-first (async may only get one pass), grouped under `##` theme headings once there are more than a handful.
- When the filled questionnaire returns, its answers are folded back as principal-ratified input: the returned Q&A appended to `## Articulation Log` as a dated `questionnaire` block, the fog entries they resolve graduated into criteria, the ones they invalidate killed via Decisions rows, the ladder updated L1 first then L2 and L3 where the answers change what the thing is, and a Decisions row naming the questionnaire as the source.

## Anti-criteria

- Never re-litigates the subject matter with the principal: the principal can't answer the subject, which is why the questionnaire exists.
- Never a compound question.
- Never asks the recipient for facts discoverable from code or files; those are looked up instead.
- No line inside the returned Articulation Log block starts with `#`.

## Inputs

### When to invoke

- User directly: `Skill("ISA", "questionnaire for <person/topic>")`
- From an ISA whose fog entries or open flags need input the principal can't supply alone.
- When a Discuss/Interview session hits "needs external input" flags worth batching for one recipient.

| Input | Required | Description |
|-------|----------|--------------|
| isa_path or topic | yes | The ISA (or bare topic) whose open questions the questionnaire serves |
| recipient | no | Who fills it in; asked for if absent |

## Gotchas

- **Recipient unknown and principal unsure who holds the knowledge:** that IS the first open flag — write the questionnaire body anyway and flag the routing.

## Output format

The questionnaire document's structure:

```
# <Title>

**Purpose:** why this exists and the decision riding on it.
**From:** <principal> — **To:** <recipient> — **How your answers will be used:** <where they go>

## Context
One paragraph orienting a recipient who wasn't in the principal's head.

## How to answer
Deadline and rough effort. Partial answers and "I don't know" are useful — flag uncertainty rather than skipping.

## <Theme>
### <One-idea question>
_Why this matters: <only where the question could be misread or invite a throwaway answer>_

>

## Anything else?
Anything we didn't ask that we should know?
```

The returned Q&A goes into `## Articulation Log` as a dated `### YYYY-MM-DD HH:MM · questionnaire — <recipient>` block (append-only).

## References

_The interview-the-send-not-the-subject shape is adapted from Matt Pocock's MIT-licensed skills repository._
