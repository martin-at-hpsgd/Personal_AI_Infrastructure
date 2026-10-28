# CodeRules

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

The smallest set of one-sentence rules an AI coding agent should follow, distilled from a tutorial, a transcript, an essay, a guide, a codebase or a stack, delivered as a bare bulleted list ready to paste into a rules file such as `CLAUDE.md`, `AGENTS.md` or `.cursor/rules`.

Our ideal-state port of Fabric's `generate_code_rules`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The rules give what the principal actually wants from this input, inferred before a word is written and never asked for. The read follows what the input is. A pasted artifact (a tutorial, a video transcript, a style guide, a postmortem, a code review, a README) means the coding practices it teaches or shows, turned into rules an agent can follow. A pasted code or config file means the conventions it demonstrates that new code would most likely get wrong (its error handling, tools, layout, naming, test style), as rules that keep new code consistent with it; each rule rests on something the file visibly does, and an incidental detail of one line is not a convention. A URL or a file path means the same for the source it points at, read in full. A bare topic or stack ("Go HTTP services", "React with TypeScript") means the rules an expert practitioner of that stack would hand an agent, the settled ones first. A question ("what rules should my agent follow for database migrations?") means the rules that answer it. "This" or "that" means the rules the current conversation established: the decisions, corrections and conventions we settled on, so the agent does not repeat a mistake made here. A typed hint ("only the testing rules", "for a Python monorepo", "just what the video says") overrides the default read.
- The source's own directions about its content count like a typed hint. What the speaker says to leave out ("don't put that in the rules", "that one's just me"), calls a personal preference, or marks as an aside or a joke stays out. A later correction ("actually, scratch that, we moved to pnpm") replaces what it corrects, and only the corrected version becomes a rule.
- The output is the list and nothing else: no title, heading, preamble or closing line, so it pastes straight into a rules file that already has its own structure. The read shows in which rules are there.
- Each rule is one sentence written as a direct instruction to the agent, opening on its verb or on "Never", "Always" or "Prefer" ("Run `pnpm test --filter <pkg>` before committing a change to that package."). It carries no explanation, rationale clause, example or softener; a reason stays in only when the rule would be misapplied without it, and then inside the same sentence.
- Every rule is concrete enough that an agent, or a reviewer reading its diff, can tell whether it was followed. Rules keep the source's exact commands, tools, versions, paths, flags and thresholds, and every command, file name, identifier and flag sits in backticks.
- A rule states the practice, never the illustration the source used to teach it. When a source shows a practice through a worked example (a sample function, an anecdote about one bug, a hypothetical file), the rule covers every case the practice covers, so it still applies in a codebase that has no such function. The source's real commands, paths, tools and identifiers stay literal; only its stand-in examples are generalized.
- A rule keeps the strength the source gave it. A firm requirement stays firm; a hedged or approximate guideline ("around 30 lines", "usually", "if you can") keeps its qualifier, often as a "Prefer" rule, and is never hardened into a strict limit or an invented exact number.
- The set is as small as the input allows. A rule earns its place only when an AI coding agent would otherwise do something different: the project's own commands and conventions, its forbidden patterns, its version and tool choices, and the non-obvious lessons the source teaches. Advice a capable model already follows unprompted ("write readable code", "use descriptive names", "handle errors") is left out. No two rules overlap, and there are at most 25; a source with four rules gets four.
- The rules run from the one whose violation would cost most (broken builds, lost data, security holes, wrong tool or version) to the least.
- Every rule is specific to this input. A line that would fit most other codebases or tutorials as well fails.
- When the input is a source, every rule is one the source states or plainly demonstrates, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs); nothing contradicts it, and no command, tool or version appears that it does not give. For a bare topic or question, every rule is current practice an expert in that stack would sign, with no version number or flag the model cannot stand behind.
- When the input teaches no coding practice, the output is the single line `No code rules found in {the source}.`, and nothing else.
- The whole output is valid Markdown with no bold and no italics: the bulleted list alone.
- `bun skills/Fabric/Tools/CodeRulesCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the rules. The model takes the default read and the rules show it.
- Never a title, a heading or any line above the list.
- Never a generic best practice a frontier coding model already follows, and never filler added to make the list longer.
- Never a rule the source does not support, never one that contradicts it, and never an invented command, flag, tool or version.
- Never a rule the source told us to leave out, one drawn from an aside or personal preference, or the superseded version of something the source later corrected.
- Never a rule tied to the source's illustrative example when the practice is general, and never a hedged guideline turned into a strict threshold.
- Never a rule written about the agent in the third person ("The AI should…", "The assistant must…") or softened ("Try to…", "Please…", "Make sure to…").
- Never a rule of two or more sentences, a rationale paragraph, a sub-bullet, a code block, a preamble, a persona, a closing summary, or any text beyond the list.
- Never markdown ordered-list syntax (`1. text`); the rules are a bulleted list.
- Never a source read from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-coderules — code checks on the bare list with no title, one-sentence bulleted rules, backticked commands, the source's literal tools and the no-rules line, plus judged checks on fidelity to the source, leaving out default behavior, concreteness, the hint override, in-source exclusions and corrections, kept hedges, generalized examples and expert practice for a bare stack.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted tutorial, transcript, guide or code file, a URL, a YouTube link, a file path, a bare topic or stack, a question about what rules an agent should follow, or "this"/"that" for the current conversation.
- An optional hint naming which rules to keep, which stack or tool they are for, or only what the source says outright, which overrides the default read.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/CodeRulesCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

| User says | Flag | Effect |
|-----------|------|--------|
| (any rules request) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, rules, none, problems}` |

## Output format

Markdown: the bulleted list, with nothing else. These are the limits the checker enforces:

- No title and no heading of any level.
- Each rule is one unindented `- ` line of 3 to 30 words (a backticked span counts as one word), one sentence ending in a period, with balanced backticks.
- A rule never opens on third-person or softening framing ("The AI", "The assistant", "You should", "Please", "Try to", "Make sure").
- There are 1 to 25 rules, and no two are the same.
- No bold or italics outside backticks, no code blocks, no numbered list.

```markdown
- {the rule whose violation costs most, one sentence, commands in backticks}.
- {the next rule}.
```

With no coding practice in the input:

```markdown
No code rules found in {the source}.
```

## References

- Upstream: `Patterns/generate_code_rules/system.md` (a "senior developer and expert prompt engineer" persona told to "think ultra hard" and distill a transcript or tutorial into the fewest unique one-sentence rules for AI-assisted coding tools, as a dash-bulleted Markdown list with no explanations; this intent keeps the deliverable, a bare list with no heading, the one-sentence instructions, the minimal set and the dash bullets, extends the inputs beyond transcripts, and drops rules a capable model already follows).
- `Tools/CodeRulesCheck.help.md`: the checker's rules and exit codes.
