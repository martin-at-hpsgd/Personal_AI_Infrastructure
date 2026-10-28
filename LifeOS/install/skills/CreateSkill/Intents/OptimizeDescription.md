# OptimizeDescription

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format · Examples · References

A skill's frontmatter `description:` rewritten and measured so the skill fires when it should and stays quiet when it should not.

The description is the main thing that decides whether a skill is invoked: the model sees each skill's name and description and chooses from those. A strong skill that never triggers is useless.

## Ideal State

- An eval set of 20 realistic queries exists: 10 should-trigger and 10 should-not. The should-trigger half covers different phrasings, formal and casual, cases where the user never names the skill, uncommon uses, and cases where this skill competes with another and should win. The should-not half is mostly near-misses: shared keywords or adjacent domains where another skill or no skill is right.
- The user reviewed the eval set before any scoring: unrealistic queries removed, their own edge cases added, any label they disagree with flipped.
- The current description and each rewrite were scored on the same set, twice per description, by a batch judge that sees every installed skill's name and description. The report gives accuracy, false negatives and false positives by query, and every query where the two runs disagreed.
- The applied description scores above 85% and no lower than the one it replaced. A rewrite that scored lower was never applied, and the previous description stands.
- The applied description is one line, at most 1024 characters, keeps the `USE WHEN` clause, says what the skill does and the specific contexts that should invoke it, and is specific enough about its own domain to beat the adjacent skills that caused confusion.
- The user saw the final description before it was written to SKILL.md.

## Anti-criteria

- Obviously irrelevant negatives that test nothing, such as "write a fibonacci function" as a negative for a PDF skill.
- Abstract or toy queries in place of what a user would actually type.
- More than three rewrite rounds against the same 20 queries, which overfits the description to the set.
- One subagent per query (20 or more spawns) in place of one batch judge per run.
- Applying a description that lowered accuracy, or one the user has not seen.
- A separate `triggers:`, `workflows:` or `intents:` array in the YAML; triggers live in the description's `USE WHEN` clause.

## Inputs

- The target skill's SKILL.md: the current `description:`, what the skill actually does, and the intents it contains.
- The adjacent skills that could compete for the same triggers, from the collected name and description list below.
- Real phrasings from `LIFEOS/MEMORY/SKILLS/execution.jsonl` (`args`, `input`) are good should-trigger seeds when they exist.

## Safety gates

- The eval set goes to the user for review before the first scoring run. Bad queries produce a bad description, so this review is not skipped.
- The final description is shown to the user before it is written to SKILL.md.
- Editing the frontmatter is a structural change and lands through CreateSkill. After writing it, re-measure the description's length.

## Tool contract

Eval set, saved as JSON:

```json
[
  {"query": "realistic user prompt here", "should_trigger": true},
  {"query": "near-miss prompt here", "should_trigger": false}
]
```

Collect every installed skill's name and description. Each record is parsed whole from its frontmatter, nothing is truncated, and the count is printed to stderr: compare it with the number of skill folders (`ls -d ~/.claude/skills/*/SKILL.md | wc -l`) and paste every line. A pasted subset leaves competitors, and possibly the target, out of the routing test.

```bash
bun -e '
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const root = homedir() + "/.claude/skills";
let n = 0; const skipped: string[] = [];
for (const rel of [...new Bun.Glob("*/SKILL.md").scanSync({ cwd: root })].sort()) {
  const fm = readFileSync(root + "/" + rel, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const get = (k: string) => fm.match(new RegExp("^" + k + ":\\s*(.*)$", "m"))?.[1]?.trim().replace(/^(["\x27])([\s\S]*)\1$/, "$2");
  const name = get("name"), description = get("description");
  if (!name || !description) { skipped.push(rel); continue; }
  console.log("- " + name + ": " + description); n++;
}
console.error(n + " skills collected" + (skipped.length ? "; no name/description in: " + skipped.join(", ") : ""));
'
```

Score one description with a single Agent subagent that judges all queries at once. Run it twice, as two separate subagent calls in parallel, and compare the runs for consistency. The subagent prompt:

```
You have access to the following skills (name and description only):

[Paste the collected name/description pairs]

For each of the following user messages, decide if you would invoke a skill.
Reply with ONLY a JSON array — one entry per query:

[
  {"query": "...", "verdict": "TRIGGER: SkillName"},
  {"query": "...", "verdict": "NO_TRIGGER"}
]

Do not explain. Just the verdicts.

Queries:
1. [query 1]
2. [query 2]
...
```

Scoring: a should-trigger query is correct when the target skill triggered. A should-not query is correct when the verdict is `NO_TRIGGER` or a different skill. Accuracy is correct verdicts divided by total verdicts. A query whose two runs disagree is flagged as inconsistent triggering.

Reading the misses, and what fixes each:

- False negative (should trigger, did not): the description lacks the phrase or domain concept the query used. Add it.
- False positive (should not, did): the description is too broad or shares vocabulary with the wrong domain. Add specificity.
- Confusion with another skill: the two descriptions claim the same territory. Name this skill's domain specifically enough to separate them.

## Gotchas

- Models tend to undertrigger: they skip a skill that would have helped. A slightly pushy description that names specific scenarios, even ones where the user would not mention the skill, beats a conservative one (Anthropic skill-creator methodology; `References/Conventions.md` § Writing guidance).
- Simple one-step queries may not trigger a skill even with a perfect description, because the model handles them directly. Should-trigger queries must be substantive enough that the skill would genuinely help, or they measure nothing.
- Every description costs context on every turn, inside one shared budget for all skills (`skillListingBudgetFraction`; SkillSystem.md § SKILL.md anatomy has the shipped default, this install's value and what overflows). Keep it tight: a short summary plus `USE WHEN` triggers, with detail in the SKILL.md body. About 500 characters is the recommendation; 1024 is the checklist ceiling.

## Output format

```
### Description Optimization Results

**Before:** [old accuracy]%
  - False negatives: [N] ([which queries])
  - False positives: [N] ([which queries])

**After:** [new accuracy]%
  - False negatives: [N] ([which queries])
  - False positives: [N] ([which queries])

**Improvement:** [delta]%
Inconsistent queries (runs disagreed): [list or none]
Rounds: [1-3]   Applied: [yes, shown to user | no, previous description kept]
```

## Examples

Queries are realistic: file paths, personal context and specific details, mixed lengths and formality, some casual or with typos.

- Bad: `"Format data"`, `"Create a chart"`
- Good: `"ok so I have this quarterly report from finance (its the xlsx in my downloads, Q4_revenue_final.xlsx) and my manager wants a comparison chart showing this quarter vs last quarter with the variance highlighted"`

## References

- Description rules (single line, TitleCase name, mandatory `USE WHEN`, no trigger arrays, the shared budget): `LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § SKILL.md anatomy.
- When the miss is in the skill's output rather than its triggering: `Intents/TestSkill.md` and `Intents/ImproveSkill.md`.
