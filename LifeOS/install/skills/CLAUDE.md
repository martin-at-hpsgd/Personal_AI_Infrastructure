# skills/CLAUDE.md

## MANDATORY: Use the CreateSkill skill for ALL skill work

Creating, modifying structure of, or validating any skill under this directory
REQUIRES invoking `Skill("CreateSkill")` first. CreateSkill's intents state the
outcome a skill must reach (`## Ideal State`, `## Anti-criteria`) and the gates
and tools that prove it: `CreateSkill/Tools/Scaffold.ts` writes new skills and intents from
the template, and IntentLint, IntentPreserve and SkillHygieneGate check the
result. Reading those intents and working toward their outcomes without the
`Skill("CreateSkill")` call is NOT compliance; handrolling bypasses the
invocation the guard and the run ledger record, and the checks that come with it.

### Triggers (MUST invoke CreateSkill)

- Creating a new skill directory
- Adding / removing / renaming Intents, Tools, or References
- Editing SKILL.md frontmatter (name, description, metadata.short-description, evals)
- Validating an existing skill against canonical format
- Canonicalizing a legacy skill
- Public-clean audit

### NOT triggers (direct edits allowed)

- Fixing a typo in a single intent file
- Updating the gotchas section in SKILL.md body (not frontmatter)
- Adding a new reference entry to an existing References/ file
- Accumulating lessons in an existing Gotchas section

### Enforcement

No hook enforces this. The `SkillCreationGuard` that blocked a `Write` creating a
new `skills/<Name>/SKILL.md` without a `CreateSkill` call was retired 2026-10-24;
`/ic` now catches hand-rolled skills after the fact. Edits, Bash-created files,
new intents, tools and references were never blocked either; the rule above is
yours to follow. If you are about to `Write`
or `Edit` a `SKILL.md`'s frontmatter or structure (its sections, routing or
file layout), create a new file under `Intents/`, `Tools/`, or `References/`,
or scaffold a new skill directory, invoke `Skill("CreateSkill")` with your
intent first and let the skill orchestrate the work. The direct edits listed
under NOT triggers (a Gotchas entry in the SKILL.md body, a typo in one
intent) stay direct.

"I read CreateSkill's intent and know what done looks like" is handrolling.
Invoke the skill; the skill holds the work to its Ideal State and runs its gates.
