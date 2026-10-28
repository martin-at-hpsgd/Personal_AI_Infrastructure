# UpdateSkill

An existing skill changed as asked (a new intent or tool, new triggers, edited documentation) and left at the intent standard, with nothing load-bearing lost.

## Ideal State

- The requested change is made and nothing else: no unrequested rewrite of intents, tools, triggers or routing. The one exception is a legacy intent the edit touched, which is canonicalized in the same edit (next criterion).
- Every intent the edit touched passes `bun LIFEOS/TOOLS/IntentLint.ts skills/<Skill>/Intents/<Intent>.md` with zero errors, and its warnings are reported with the change. A touched legacy intent is brought to the standard in the same edit under CanonicalizeSkill's rules, so editing a file never leaves it worse or merely as legacy as before.
- A new intent was written by `Tools/Scaffold.ts intent`, so it started from the template and its routing row exists; every routing row points at an existing file whose name matches it exactly, every intent file has a row, and a new reference file has a row in the File / Read when table.
- SKILL.md still opens with its skill-level `## Ideal State` and `## Intent Routing`, updated when the change shifts what the skill delivers, and every file the edit pushed past 100 lines carries its `**Contents:**` line (`bun LIFEOS/TOOLS/SkillContents.ts --write skills/<Skill>`).
- A new tool is `Tools/<ToolName>.ts` with `Tools/<ToolName>.help.md`, exposes its behavior through flags, and the intent that calls it carries the exact command and an `### Intent-to-Flag Mapping` table under `## Tool contract`.
- When the edit removed text from any `.md` in the skill, `bun LIFEOS/TOOLS/IntentPreserve.ts --base HEAD skills/<Skill>` exits 0; each deliberate removal is listed in an allow file with its reason.
- Frontmatter still holds a `metadata.short-description` of one plain line within 170 code points (IntentLint `summary-*`), a single-line `description` with `USE WHEN` of at most 1024 characters, no `triggers:`, `workflows:` or `intents:` arrays, no key off the permitted list (a harness key such as `context: fork` or `allowed-tools` found on a touched skill is removed in the same edit and its fork wording rewritten as plain skill behavior, with every quality bar kept; `disallowed-tools` holding a skill read-only stays), and an `evals:` disposition that names real verification under the contract in `References/Conventions.md` § Verification. A skill with no `evals:` key or a legacy `declined:` record leaves with an explicit form.
- A promotion (a private `_ALLCAPS` skill renamed public) meets every bullet in `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Promoting a private skill, Setup.md included, and ships no deployable backend: the service is described in Setup.md and its package stays in USER.
- Evidence affected by the edit was rerun (`bunker test --skill <Name>` for the fast contract; suites on explicit `--deep` after prerequisites), and only that evidence.
- `SkillHygieneGate.ts --skill <SkillName>` exits 0 (add `--no-deny-list` on an install with no deny-list, where it otherwise exits 2), and the verdict is in the same response as the change.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Anti-criteria

- No new intent or tool created with `touch` or an empty file.
- No change that removes a tool, flag, path, safety gate, permission check or gotcha without an allow-file entry naming why.
- No hand-bump of `version:` where a maintainer release flow owns version bumps, and no edit to `LIFEOS/VERSION`.
- No edit to a file holding another session's uncommitted changes.
- Never reported done while IntentLint has an error on a touched intent or the hygiene gate fails.

## Safety gates

- **Major changes stop for confirmation.** Renaming the skill, removing an intent, or breaking its routing or public contract is a major change (`References/Conventions.md` § Versioning): describe it and wait for the principal's yes before making it.
- **Shared tree.** `git status --short skills/<Skill>` before the first edit. A file with uncommitted changes this session did not make belongs to a peer: leave it and report it.
- **Hygiene gate before reporting.** An edit is not done until the gate passes; a violation moves the data under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<Skill>/` and references it by path.

## Tool contract

Run from `~/.claude`.

```bash
bun skills/CreateSkill/Tools/Scaffold.ts intent <Skill> <IntentName> --trigger "<trigger phrase>"
#   appends the row after the last table under ## Intent Routing whose header starts with Intent
#   (the last table there only when none does); --no-route prints it instead
#   refuses an existing intent, and a skill with no Intents/ (single-intent): first move its Anti-criteria and
#   deliverable bullets into Intents/<First>.md, keep a skill-level Ideal State in SKILL.md, then scaffold
bun LIFEOS/TOOLS/IntentLint.ts skills/<Skill>/Intents/<IntentName>.md
bun LIFEOS/TOOLS/IntentPreserve.ts --base HEAD [--allow <reasons.tsv>] skills/<Skill>
#   allow file: one line per deliberate removal, <repo-relative path>\t<token>\t<reason of 8+ chars>
bunker test --skill <Name>
bun ~/.claude/LIFEOS/TOOLS/SkillHygieneGate.ts --skill <SkillName>
```

Description edits keep the single-line form in `References/Conventions.md` § SKILL.md shape and loading, with the `NOT FOR` clause only when a neighbor shares vocabulary.

## Output format

The report names each file changed and what changed in it, the IntentLint result per touched intent (errors and warnings), the IntentPreserve result and any allow-file entries, the hygiene-gate exit code, the `evals:` disposition, and the change class (patch, feature or major) for the ship flow.

## References

- `References/Conventions.md` — naming, frontmatter, verification, versioning.
- `Intents/CanonicalizeSkill.md` — the rules for bringing a touched legacy intent to the standard.
- `Assay/References/Progressive.md` — lanes and when suites run.
