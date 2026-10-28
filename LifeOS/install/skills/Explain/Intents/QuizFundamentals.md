# QuizFundamentals

A quiz on the fundamentals of one area the principal works in, graded against the area as it is today and recorded, so each quiz goes after what the principal missed last time and what changed since. Shortcut: `/qf [area] [N]`.

## Ideal State

- The area resolves the same way ExplainFundamentals resolves it, and uses the same `area-slug`.
- The questions test the area's fundamentals as they are today. The last recorded explain set for the area is the starting spine. The live sources are reread this session, and a fundamental that has changed or appeared since that set was recorded is included. When the area has never been explained, the intent builds the set itself with ExplainFundamentals' test and records it as an explain row before asking.
- There are N questions, 5 by default, asked one per turn. Each turn ends at its question, and the `🗣️` closer carries the question so it is spoken.
- Questions test application over recall: "the deploy just failed with X, which part do you check first and why?", "what breaks if Y goes down?", "what does A hand to B?". Every quiz includes at least one connection question and one failure question.
- The record sets the order. Fundamentals he missed or half-answered before come first, then fundamentals that changed since his last quiz, then ones he has never been asked. A fundamental he got right on each of its last two quizzes is asked only when nothing else is due.
- Each answer gets a verdict of right, partial or wrong, never softened. The verdict quotes his own words, gives the correct answer with the source it came from, and gives one line on why. Two misses on the same fundamental in one quiz get it re-taught from a different angle before the next question.
- The source decides the verdict. When his answer matches what is actually running but the doc or ISA says otherwise, the verdict says he is right, and the drift is named as a finding in the summary.
- Each answer is appended to the record as soon as it is graded, so a quiz he stops halfway still counts.
- The quiz ends with his score, a per-fundamental table with a status mark (✅ ⚠️ ❌) and his trend on this area from earlier quizzes, the fundamentals to revisit, and any source drift the quiz found.

## Anti-criteria

- Never answers its own question and keeps going.
- Never asks trivia (file names, line numbers, version strings, port numbers) unless the fact is load-bearing for a fundamental.
- Never grades from memory when the live source can be read.
- Never puts a secret value, credential or token in a question, a verdict or the record.
- Read-only apart from the learning record. A drift it finds is reported, never fixed during the quiz.

## Inputs

- `$ARGUMENTS`: the area and an optional question count (`/qf <area> 8`). Empty means the conversation's area. With no area in play, the intent offers the areas that are most overdue: the ones with misses on the record, or not quizzed in the longest time.

## Tool contract

Run from the LifeOS root (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when set).

```bash
bun LIFEOS/STATVS/Statvs.ts tail --stream learning --n 2000    # explain and quiz rows; filter by data.area
bun LIFEOS/TOOLS/SystemContext.ts load projects                # resolve the area and its sources
```

After each graded answer:

```bash
bun LIFEOS/STATVS/Statvs.ts append --writer explain --stream learning --kind quiz \
  --title "<area>: <fundamental>" --data '{"area":"<area-slug>","fundamental":"<name>","question":"<question>","answer":"<his answer, one line>","verdict":"right|partial|wrong","source":"<path or URL>","quiz":"<quiz id, the first row's ISO timestamp>"}'
```

## Gotchas

- **Teach owns "quiz me" right after a lesson.** This intent runs when an area is named or `/qf` is typed (SKILL.md § Gotchas).
