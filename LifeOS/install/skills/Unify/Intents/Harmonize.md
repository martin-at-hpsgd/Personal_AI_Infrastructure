# Harmonize

Analyze a set of inputs for harmony and conflict, and recommend how to unify them.

## Ideal State

- A finished Unify report names the real fault lines in the set, keeps the tensions that are doing useful work, and hands over a short list of changes that would make the whole pull in one direction.
- Each input's principles and aim in the report come from its own source, cited, never from a one-line summary of it.
- The Stragglers list covers the surround, not just the headline: every input's intents (ISAs, stated purposes) and everything that implements or restates it (docs, skills, intents, hooks, tools, config), with every straggler that still says something the current intent contradicts listed with its path and line. The list is complete for the scope, not a sample.
- The summit is explicit. The report states what the set as a whole is for, with its source, and judges every relationship against that.
- Conflict is separated from tension. Two inputs pulling opposite ways on purpose (speed against verification) is a tension with a balancing rule, and it stays. Two inputs whose aims cannot both be met is a conflict, and it gets a fix.
- Each finding carries its mechanism. Not "these clash" but which principle in A defeats which principle in B, under what conditions, with evidence from both.
- The thinking skills ran before the findings were written. FirstPrinciples, Superior and SystemsThinking (plus others when the material calls for them) were invoked through the Skill tool on the material gathered, their contributions are visible in the findings, and the lens trail names what each one changed or confirmed. Each brief to a thinking skill carried the facts and paths already found.
- Recommendations are few, ranked, and placed. At most about seven, ranked by harmony gained per unit of effort, each one names the conflicts it resolves, the file or system it lands in, the check that would prove it worked, and whether it needs the principal's yes.
- The report carries the eight parts in the Output format order, from the 🎯 verdict to the lens trail, printed in the terminal for a small run and written to the Downloads path for a full LifeOS run.

## Anti-criteria

- Never judges relationships against an aim invented for the set rather than one the input set and its summit actually support.
- Never edits an input, even an obviously broken one: recommendations stay recommendations, and nothing is edited before the principal's yes.
- A paraphrase of what a thinking skill would say never counts as running it.
- No conflict is asserted with no cited source on both sides, no productive tension is recommended away, and no recommendation resolves no named conflict.
- A second agent confirming a conflict without quoting both sources is never counted as evidence.
- Never judges a set it cannot read or state a purpose for. When inputs are named but unreadable, or no shared summit can be stated, it asks at most three questions, with a `proceed` override. When the set is workable but ambiguous, it judges the best reading and says so in one line: `⚠️ Picking X over Y because R; redirect if wrong.`

## Output format

The report, in this order:

1. **🎯 The verdict** — one sentence on how unified the set is and the single biggest fault line.
2. **Summit** — what the set as a whole is for, with its source.
3. **Inputs** — one row per input: core principles, ultimate aim, source.
4. **Harmony map** — a table of the relationships that matter (not every pair):

   | A | B | Relationship | Mechanism | Evidence (both sides) |
   |---|---|---|---|---|

   Relationship is one of: **reinforcing**, **productive tension** (keep, name the balancing rule), **drift** (vocabulary or stale wording), **duplication** (two owners of one job), **straggler** (a leftover statement in a doc, skill, hook, ISA or config that contradicts the input's current intent; cite its path and line), **conflict** (aims cannot both be met), **gap** (part of the summit nothing serves).
5. **Stragglers** — every leftover found, one row each: path:line, what it says, which current intent it contradicts, and the fix (update, delete, or point at the canonical home). This list is complete for the scope, not a sample.
6. **Unifying principle** — the one statement that, adopted, resolves the most conflicts at once, or a plain statement that none exists.
7. **Recommendations** — ranked by harmony gained per unit of effort, at most about seven:

   | # | Change | Resolves | Lands in | Proof it worked | Needs yes? |
   |---|---|---|---|---|---|

8. **Lens trail** — one line per thinking skill: what it found that changed or confirmed a finding.

A small run prints the report in the terminal. A full LifeOS run writes it to `~/Downloads/Unify-<scope>-<YYYYMMDD>.md` and gives a short terminal summary with the path. A written report passes `bun skills/Unify/Tools/CheckReport.ts <path>` before it is handed over (§ Tool contract).

## Inputs

- **Named inputs:** exactly what the principal gave — files, URLs, skills, systems, pasted text, ideas in the conversation.
- **No inputs:** the default LifeOS set in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Unify/Config.md` (a missing file stops the run, per SKILL.md § Data & Config). Discover the current set of sources with `bun LIFEOS/TOOLS/SystemContext.ts list` and `list docs`; read sections with `load <source> ["Heading"]`. The set drifts, so enumerate it fresh each run.
- **The surround of every input:** each input's intents and everything that restates it, not only its main document. For a LifeOS component that means its ISA (Ideal State, criteria, Decisions), its system doc, the skills, intents, hooks, tools, config, and commands that implement it, and every other file that describes or quotes its rules. When a rule changes, its canonical home is usually updated and its copies are not, so search the whole tree for each input's key rules and terms (`rg` over `git ls-files`, `SystemContext.ts search "<term>" docs|skills`) so a straggler anywhere surfaces.
- **Partial scope:** "Unify the memory systems" means the LifeOS components that bear on memory, chosen by reading, and the report names what was in and out.

## Safety gates

Recommendations stay recommendations. On the principal's yes, each accepted one becomes an Upgrades proposal (or a fix in the same turn when the principal asked for the fix). Nothing is edited before that.

## Tool contract

Invoke these through the Skill tool, on the material gathered. When FirstPrinciples, Superior or SystemsThinking already ran through the Skill tool in this conversation on the same input set, Unify cites that output instead of re-running it, and that meets the Skill-tool requirement; a different input set runs fresh.

- **FirstPrinciples** — each input's irreducible aim, and whether each conflict is a hard constraint or an inherited assumption.
- **Superior** — how a far smarter designer would make this set one system, and the gap between that and what exists.
- **SystemsThinking** — where the inputs form loops that fight (fixes that fail, shifting the burden, duplicated control), and the leverage points.

Add others when the material calls for them: ApertureOscillation when local rules and the global design disagree, RedTeam to attack the recommendations before they ship, IterativeDepth for a large set with hidden interactions, Council when the right resolution is a genuine judgment call.

`bun skills/Unify/Tools/CheckReport.ts <report.md> [--max-recs N] [--json]` checks a written report's shape: the eight parts in order, a known relationship and non-empty both-sides evidence on every harmony-map row, a `path:line` on every straggler, and filled Resolves, Lands in and Proof cells on at most `--max-recs` recommendations. Exit 0 pass, 1 contract broken, 2 usage. It cannot say whether a finding is real (`Tools/CheckReport.help.md`).

### Intent-to-Flag Mapping

| The run needs | Flag |
|---|---|
| The saved report to check | `<report.md>` (positional) |
| A different recommendation cap than the default 8 | `--max-recs N` |
| Machine-readable result | `--json` |
