# ValidateSkill

A COMPLIANT or NON-COMPLIANT verdict on an existing skill, decided by code first and by judgment only where code cannot decide.

## Ideal State

- Each mechanical check's exit code is in the report: `IntentLint.ts` over the skill (any error fails the skill; warnings are reported), `SkillHygieneGate.ts --skill <SkillName>` (nonzero fails), and the structural checks below.
- The structural checks cover: skill directory, intent, reference, tool and help files named per `References/Conventions.md` § Naming; frontmatter `name` matching the directory, a `metadata.short-description` of one plain line within 170 code points (already raised by IntentLint as `summary-*`), single-line `description` with `USE WHEN` (`description: <What it does>. USE WHEN <triggers>. NOT FOR <neighbor> (<OtherSkill>).`), at most 1024 characters, no `triggers:`, `workflows:` or `intents:` arrays, no frontmatter key off the permitted list (raised by SkillHygieneGate as `frontmatter-key`; `References/Conventions.md` § SKILL.md shape and loading); `## Ideal State` as the first H2 and `## Intent Routing` directly after it (after `## Anti-criteria` in a skill with no intents), every row pointing at an existing file with an exactly matching name, every intent, reference and root `.md` file named there and every other `.md` directory named as `Dir/`; every file over 100 lines with two or more H2s, outside directories routed as `Dir/`, carrying a current `**Contents:**` line; `## Data & Config` present when the skill reads USER data or customizations (anything under `LIFEOS/USER/`, including `CUSTOMIZATIONS/SKILLS/<SkillName>/`); `## Gotchas` and `## Examples` (two or three patterns) present; no voice block (a `## Voice Notification` section, a notify curl, a "Running the..." line) in any `References/` or skill-root `.md` file, where IntentLint checks only the contents line; SKILL.md under 500 lines; no .md nested inside Intents/ (the one depth rule; a deeper folder elsewhere, such as `Templates/Primitives/`, is reported only as information), no `backups/` inside the skill, reference docs at the root or in `References/` and never in `Intents/`.
- The `evals:` contract is checked as `References/Conventions.md` § Verification states it: a missing key is a finding ("verification disposition missing — name real evidence"); named suites resolve in the Assay runner's USER-first order and contain runnable cases; a deterministic entry names a command and a concrete falsifier; a manual exception names its reason and its falsifier; `pending:` and legacy `declined:` are reported as unverified, never as compliant.
- For a skill with CLI tools: each tool exposes its behavior through flags per its `--help` (mode flags such as `--fast`, `--thorough`, `--dry-run`; output flags such as `--format`, `--quiet`, `--verbose`; resource flags such as `--model`; post-processing flags where they apply), and every intent that calls it carries an `### Intent-to-Flag Mapping` table under `## Tool contract`.
- Judgment is spent only on what code cannot decide, and each judgment cites the line it judged: whether every Ideal State bullet is testable (a reader could show an output failed it); whether any remaining section is choreography in disguise (a Tool contract or Gotchas list that is really a list of thinking moves, a gotcha with no provenance); whether the description needs `NOT FOR` because a neighbor shares its vocabulary (research vs investigation, assessment vs reconnaissance, blog vs newsletter), in the description form above; whether any line fails the smarter-model test.
- Validating one skill needs no network. The official-spec comparison runs only when the validation targets CreateSkill itself or the request asks for a doctrine or spec-drift check; then any divergence is reported with both sources quoted as a finding about our doctrine, not about the skill under validation. Otherwise the report's Spec drift line says `not requested`.

## Anti-criteria

- Never edits, creates or deletes a file in the skill. Findings are reported; fixes route to CanonicalizeSkill or UpdateSkill. Data that fails the gate belongs in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/`, and the report says so.
- Never substitutes a hand-rolled grep for the hygiene gate.
- Never counts `pending:`, a legacy decline, an empty or unresolved suite, or a falsifier like `n/a` as verified.
- Never reports COMPLIANT with a lint error, a hygiene failure or a failed structural check outstanding.
- Never auto-adopts drift found in the official spec.

## Safety gates

- **The spec-drift check is advisory.** An unreachable URL gets `⏳ skipped (unreachable)` and validation continues. Confirmed drift routes to the principal or an Upgrade-skill recommendation.
- **The hygiene gate does not see bare first names.** Neither the deny-list nor the gate's name-literal set carries the principal's or the partner's legal first name bare (the deny-list carries the partner's nickname; checked 2026-10-10), so the report also covers a grep of the skill for the principal's and partner's first names (taken from the identity files) and flags any that are not a public citation or detection pattern, along with any hardcoded secret, API key, token or bearer credential (zero tolerance; env var names only).

## Tool contract

Run from `~/.claude`; every command here is read-only.

```bash
bun LIFEOS/TOOLS/IntentLint.ts skills/<Skill> --json
bun ~/.claude/LIFEOS/TOOLS/SkillHygieneGate.ts --skill <SkillName>
find ~/.claude/skills/[SkillName]/ -type d -mindepth 2 -maxdepth 3   # a hit under Intents/ is a finding (nested-intent); elsewhere it is information, not a failure
bun ~/.claude/skills/[SkillName]/Tools/[ToolName].ts --help
grep -l "### Intent-to-Flag Mapping" ~/.claude/skills/[SkillName]/Intents/*.md
```

Official spec sources for the drift check, when it runs:

- Agent Skills docs: https://code.claude.com/docs/en/skills
- Reference skills repo: https://github.com/anthropics/skills

Compare their frontmatter contract (recognized fields, description limits, loading behavior) with what `SkillSystem.md` and this skill assert.

## Output format

```
VERDICT: COMPLIANT | NON-COMPLIANT

Mechanical
  IntentLint        exit <n>   <errors> errors, <warnings> warnings   (file:line rule, one per line)
  SkillHygieneGate  exit <n>   <violations>
  Structure         <pass | each failed check with file:line>
  evals             <disposition>   verified | unverified (<why>)
  CLI-first         <n/a | each finding>

Judgment
  <file:line> — <finding> — <why code could not decide it>

Spec drift
  <not requested | none | skipped (unreachable) | divergence with both sources quoted>

Next
  <CanonicalizeSkill | UpdateSkill | OptimizeDescription, with the findings each would close>
```

## References

- `References/Conventions.md` — naming, public-release readiness, folder structure, SKILL.md shape, verification.
- `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy — what IntentLint enforces.
- `~/.claude/LIFEOS/DOCUMENTATION/Tools/CliFirstArchitecture.md` — flag configuration and intent-to-flag mapping.
