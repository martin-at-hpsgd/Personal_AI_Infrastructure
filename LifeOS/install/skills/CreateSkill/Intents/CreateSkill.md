# CreateSkill

A new LifeOS skill whose SKILL.md and every intent are written to the intent standard and pass every gate the first time they run.

## Ideal State

- The skill exists at `skills/<Name>/` under a valid name: `TitleCase` when a stranger could drop it into their `skills/` directory, fill in their own `Config.md`, and have it work, `_ALLCAPS` only when its data or behavior cannot move into `Config.md` (the test and its table: `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Public vs Private Skills, summarized in `References/Conventions.md` § Naming). Every file inside uses the naming in that section, every intent sits directly in `Intents/` (IntentLint `nested-intent` otherwise), and the rest of the tree keeps to two levels, `skills/<Name>/<Dir>/<file>`, the target in `References/Conventions.md` § Folder structure.
- `bun LIFEOS/TOOLS/IntentLint.ts skills/<Name> --strict` exits 0: every intent opens with `## Ideal State` (at least two testable bullets that describe the deliverable and its qualities, never steps) followed by `## Anti-criteria`, and after them uses only Inputs, Safety gates, Tool contract, Gotchas, Output format, Examples and References.
- Every intent and the SKILL.md were written by `Tools/Scaffold.ts` from `References/IntentTemplate.md` and then filled in. The filled bullets are specific to this skill: a reader could point at an output and say which bullet it failed.
- A coverage record existed before any directory did. `SkillCoverage.ts` ran on a one-sentence statement of the skill, and the announcement names ROUTE, ABSORB or NET-NEW with its reason, including when the check exited 0.
- The skill earns its place under the smarter-model test: it carries knowledge a model cannot derive (API quirks, decisions, failure modes) or tools it cannot replicate. Its type (one of the nine in `References/Conventions.md` § Skill types) is named and visibly shaped it; a deployment skill carries safety gates, a library-reference skill is mostly gotchas.
- Frontmatter: `version: 1.0.0`; a `metadata.short-description` of one plain line within 170 code points (IntentLint `summary-missing`, `summary-too-long`, `summary-malformed`); a single-line `description` with `USE WHEN`, a `NOT FOR` clause when a neighbor shares vocabulary, at most 1024 characters; and an `evals:` disposition that names a runnable suite, a deterministic command with its falsifier, or a manual exception with reason and falsifier. No other key is added: the skill runs inline like every skill, with no harness key (`context`, `background`, `allowed-tools`, `model`, `effort` and the rest; `References/Conventions.md` § SKILL.md shape and loading). `pending:` appears only while real evidence is not ready, and the announcement reports it as unverified.
- SKILL.md carries a purpose paragraph, then `## Ideal State` for the skill as a whole, then `## Intent Routing` whose rows match the intent files exactly and which names every reference file, `## Data & Config` when the skill reads USER data, `## Gotchas`, and `## Examples` with two or three concrete patterns, and stays under 500 lines.
- The skill is publishable-clean, public or private: `SkillHygieneGate.ts --skill <Name>` exits 0 (add `--no-deny-list` on an install with no deny-list, where it otherwise exits 2), the bare-name grep finds nothing that is not a public citation or detection pattern, and every personal datum or config value lives under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<Name>/` (or the canonical USER home that owns it) and is read by path.
- A skill that needs setup (an account, a key, config, a service behind it) carries `Setup.md` with the four parts in `References/Conventions.md` § Public-release readiness, linked from `## Data & Config`, with a proof that runs shipped code. A service the skill depends on is described there for the reader to build; its source, configs and migrations stay under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<Name>/`.
- An intent that produces a substantive artifact carries the sufficiency anti-criterion from `References/IntentTemplate.md`; an intent whose deliverable depends on an earlier output states that output as an Ideal State bullet and, when it is a file, in `contract.requires`.
- An intent that calls a CLI tool carries the exact command and an `### Intent-to-Flag Mapping` table (what the user says → flag → effect) under `## Tool contract` (`~/.claude/LIFEOS/DOCUMENTATION/Tools/CliFirstArchitecture.md`), and the tool exposes its behavior through flags rather than hardcoding one pattern.

## Anti-criteria

- No intent or SKILL.md created with `touch`, a heredoc, or a hand-typed skeleton.
- No intent that choreographs reasoning (`Step 1..N`, "first analyze, then consider"), and no `## Voice Notification` section, notify curl, or "Running the X intent" line anywhere in the skill (IntentLint raises each in SKILL.md and every intent).
- Never scaffolds on a guessed purpose. When what the skill does, what should trigger it, or which intents it needs is unclear, at most three questions come before any file.
- No skill directory before the coverage record. No new skill when ROUTE applies; no ABSORB that leaves the superseded skill standing.
- No sensitive value in the skill body: no real names, domains, tokens, private repo paths or home-path literals, even in a private skill.
- No catch-all `Context/` or `Docs/` subdirectory (a directory beyond `Intents/`, `Tools/` and `References/` groups files of one kind and is routed as `Dir/`), no `backups/` inside the skill, no `.md` nested inside `Intents/`, no separate `triggers:`, `workflows:` or `intents:` arrays.
- No edit to `LIFEOS/VERSION` and no `version:` other than the scaffolded `1.0.0`.
- No invented verification: no suite name that does not resolve, no synthetic eval cases, no bare decline.
- Never announced as created while IntentLint or the hygiene gate fails.

## Safety gates

- **Coverage before scaffolding.** A nonzero `SkillCoverage.ts` exit means a strong candidate already exists. ROUTE is the default: add an intent under the existing skill instead, because intents route by deterministic name match while skills route by model judgment over descriptions. ABSORB means the new skill supersedes named skills, retired in the same motion through `Intents/Retire.md`. NET-NEW must say why the matches do not cover the need (different data store, tooling or trigger vocabulary); thematic similarity is not coverage, and "the existing skill is crowded" is not a reason.
- **Hygiene gate before the announcement.** Run it and report the verdict in the same response that announces the skill, never afterward or on request. A violation is fixed by moving the data to `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<Name>/` and referencing it by path. For a private `_*` skill this gate is the only content check (`References/Conventions.md` § Public-release readiness).

## Tool contract

Run from `~/.claude`.

```bash
bun ~/.claude/LIFEOS/TOOLS/SkillCoverage.ts "<one sentence describing what this skill would do>"
bun ~/.claude/LIFEOS/TOOLS/SkillCoverage.ts --pairs        # periodic library audit, not per-create

bun skills/CreateSkill/Tools/Scaffold.ts skill <Name> --intents <IntentA,IntentB> --description "<What it does>. USE WHEN <triggers>. NOT FOR <neighbor>."
bun skills/CreateSkill/Tools/Scaffold.ts skill <Name> --single --description "<...>"     # no Intents/; SKILL.md carries Ideal State and Anti-criteria
#   add --data-config when the skill reads USER data; --json for machine output
#   exit 0 written, 1 refused (invalid name, exists, bad description), 2 template unreadable; never overwrites

bun LIFEOS/TOOLS/IntentLint.ts skills/<Name> --strict
bun ~/.claude/LIFEOS/TOOLS/SkillHygieneGate.ts --skill <SkillName>
bunker test --skill <Name>
```
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

The bare-name grep runs `rg` over `skills/<Name>/` for the principal's and partner's first names, taken from the identity files at run time, never typed into the skill.

## Output format

The response that announces the skill contains, in this order:

- The path and the public/private choice with its one-line reason.
- The skill type.
- The coverage disposition (ROUTE, ABSORB or NET-NEW) and its reason.
- The IntentLint and SkillHygieneGate results, each with its exit code.
- The `evals:` disposition, marked unverified if it is `pending:`.
- An offer to run TestSkill against a no-skill baseline, and OptimizeDescription for the new description.

## Examples

A filled intent, from a scaffold of `Tools/Scaffold.ts skill RecipeBox --intents AddRecipe`:

```markdown
# AddRecipe

A recipe saved to the principal's recipe store, deduplicated and tagged.

## Ideal State

- The store holds exactly one entry for the recipe, with title, ingredients with quantities, steps, source URL and tags.
- A recipe already present by source URL or normalized title is updated in place, and the response says which.

## Anti-criteria

- Never invents a quantity or step the source does not give; a gap is marked "unspecified".
- Never writes outside `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/RecipeBox/`.

## Tool contract

`bun skills/RecipeBox/Tools/Recipes.ts add --url <url> [--tags a,b] --json` (exit 3 = duplicate found, entry updated)
```

## References

- `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy — the standard (canonical).
- `References/IntentTemplate.md` — the templates and the standard bullets for common intent shapes.
- `References/Conventions.md` — naming, public-release readiness, folder structure, SKILL.md shape, skill types, writing guidance, verification, versioning.
