---
name: SuggestSkills
evals:
  manual:
    reason: "a proposed skill is useful only when its evidence-grounded gap and scope fit the observed work history"
    falsifier: "the reviewer finds a recommendation duplicates an existing capability, lacks supporting signals, or has no bounded user need"
metadata:
  short-description: "Propose new skills from work history and recurring frustration; identify unmet needs without editing skills. Use CreateSkill to build or improve them."
version: 1.2.2
description: Proposes which new skills to build from work history and frustration signals; read-only, it hands a ranked shortlist to CreateSkill. USE WHEN should I create a skill, what skills do I need, suggest skills, skill gap, based on my recent work, am I missing a skill, what should I build. NOT FOR creating, validating, or optimizing an individual skill (CreateSkill).
---

# SuggestSkills — what should I build next?

A read-only analytics pass over your own work. It answers one question: given what you have actually been doing and where you have been frustrated, is there a recurring problem that deserves its own skill and does not have one yet? It proposes; you decide; `CreateSkill` builds. It has no capability to create or edit a skill, by design.

## Ideal State

- Every proposal on the shortlist traces to recorded evidence (sessions, Errata frustration rows, skill-gap detections) from one tool-built corpus, so a second run over the same window judges the same evidence.
- Gaps hiding under nominally covered topics surface: frustration outweighs topic frequency, and coverage means the discipline is handled, not that a topic shares a keyword.
- The pass stays read-only: no skill is created or edited, and an accepted proposal reaches CreateSkill only as a separate, human-approved step.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Scan** | "what skills should I build", "skill gap", "suggest skills", "am I missing a skill" | `Intents/Scan.md` |

## Data & Config

The skill reads no config file. `Tools/CollectSignals.ts` takes everything from flags and env vars, and each store resolves flag > env > the first conventional default that exists under the root:

- Root: `--root <dir>`, else `SKILLSCAN_MEMORY_ROOT`, else `$HOME/.claude`.
- Window and cut: `--days <n>` (default 45, 1-3650) and `--max-rating <n>` (default 4, 1-10).
- Stores: `--ratings <dir>` / `SKILLSCAN_RATINGS_FILE` (the Errata ledger directory), `--work <dir>` / `SKILLSCAN_WORK_DIR`, `--skill-gaps <file>` / `SKILLSCAN_SKILL_GAPS_FILE`, `--skills <dir>` / `SKILLSCAN_SKILLS_DIR`, and `--loops <dir>` / `SKILLSCAN_LOOPS_DIR` (opt-in, no default).

The full flag table is in `Intents/Scan.md` § Tool contract.

## Gotchas

- None span intents yet. The collector's gotchas live in `Intents/Scan.md` § Gotchas.

## Examples

**Example 1: routine gap scan**
```
User: "What skills should I build based on my recent work?"
→ Scan intent, last 45 days
→ A ranked shortlist with evidence per proposal, deduplicated against existing skills and intents; nothing is created
```

**Example 2: frustration-led scan**
```
User: "I keep hitting the same wall — am I missing a skill?"
→ Scan intent, frustration store as the lead signal
→ The shortlist includes discipline gaps hiding under topics that look covered
→ User accepts one proposal → handed to CreateSkill as a separate step
```
