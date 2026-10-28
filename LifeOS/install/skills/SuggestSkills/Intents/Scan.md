# Scan

A ranked, evidence-backed shortlist of skill gaps drawn from work history and frustration; read-only, it proposes and never creates a skill.

## Ideal State

- Every in-window Errata complaint counts as frustration, rated or not: a rated row counts at or below the rating cut, and an unrated complaint, correction, bug or incident row always counts, because most explicit complaints are captured without a rating.
- All evidence comes from one `Tools/CollectSignals.ts` corpus whose `warnings` and `missing` were read first, so two runs judge the same corpus.
- The report header states the window, the session count and whether the frustration store was present; when the tool reports the ratings store missing, the report says the frustration signal was unavailable for this run rather than presenting a topic-only result as complete.
- When the caller asked about a specific domain, the clustering is scoped to it and the report says so.
- Sessions and frustrations are grouped into recurring themes, each carrying two numbers: recurrence (how many sessions) and friction (how many frustration rows / recurrence markers like "regressed again"), with frustration outweighing raw topic frequency, because low ratings and repeat recurrence are the strongest signal a skill is missing. Every `skillGaps` date is matched to the `sessions` of that date, so each detection names the work that was actually happening.
- Every cluster is classified BEHAVIOR-FEEDBACK, COVERED or GAP as defined under Output format, and every COVERED verdict rests on reading the covering unit's body and mapping the specific failure class to explicit guidance in it.
- Two independent passes classify the clusters from the same corpus, and the report includes every cluster either pass flags as GAP, tagged by agreement: `both` (high confidence) or `one` (needs review).
- The deliverable is a ranked shortlist in the Output format shape: each proposal carries a name, a one-line description and evidence (recurrence, friction, skill-gap detections, the specific recurring failure it would prevent).
- A clean topic-coverage result with dirty frustration signals is a false negative: the area marked covered is re-opened, because the discipline under that topic is the gap (the failure this skill was built to fix). The recommendation says "nothing new" only when the frustration signals are also clean.

## Anti-criteria

- Never creates or edits a skill: accepted proposals go to `CreateSkill` as a separate, human-approved step.
- Never re-gathers the corpus by hand; the tool is the single source of evidence.
- Never drops a single-pass gap: strict intersection hides the subtle discipline gaps this skill exists to surface.
- Never marks a cluster COVERED on its name: if the covering unit's body does not address the failure, it is not covered.
- Never proposes BEHAVIOR-FEEDBACK (verbosity, scope misreads, reminder cadence) as a skill; it routes to memory/preferences.
- Never writes secrets, client/project names or personal paths to a review location.

## Inputs

`skillGaps[]` is the third signal. `AlgorithmNudge`'s `skill-gap` row fires at the end of a substantive session that invoked no skill and matched no skill's USE WHEN, and appends one counts-only row to `MEMORY/OBSERVABILITY/skill-gap-candidates.jsonl`. A row carries counts only, never content, so a date in `skillGaps` is a pointer to the session of that date, not a description of it. Two or more on nearby dates is the strongest evidence in the corpus that a real gap exists, because a machine noticed the absence at the moment it happened rather than reconstructing it later.

## Tool contract

```bash
bun ~/.claude/skills/SuggestSkills/Tools/CollectSignals.ts --days 45 > "${TMPDIR:-/tmp}/skill-scan-corpus.json"
```

### Intent-to-flag mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (default), "recently", "lately" | `--days 45` | 45-day window |
| "this quarter", "last few months" | `--days 90` | wider window; expect a much longer session list |
| "all time", "everything" | `--days 3650` | full history (clamped at 3650) |
| "only the really bad ones" | `--max-rating 2` | tighten the rating cut for rated rows (default 4); unrated complaint-class rows still count |
| "scan another install / another tree" | `--root <dir>` | re-resolve every store under a different root |
| a store lives somewhere non-standard | `--ratings <dir>` `--work <dir>` `--skill-gaps <file>` `--skills <dir>` `--loops <dir>` | override one store; a bad explicit path is reported, never silently defaulted. `--ratings` takes the Errata ledger directory (monthly `errata-YYYY-MM.jsonl` files), not one file: a file path is reported in `warnings` as unreadable and the frustration signal is empty |

Each store resolves via flag > env (`SKILLSCAN_MEMORY_ROOT`, `SKILLSCAN_RATINGS_FILE` (despite the name, a directory), `SKILLSCAN_WORK_DIR`, `SKILLSCAN_SKILL_GAPS_FILE`, `SKILLSCAN_SKILLS_DIR`, `SKILLSCAN_LOOPS_DIR`) > the first conventional default that exists under `--root` (`LIFEOS/MEMORY/...`, then a bare `MEMORY/...`). Loops are opt-in: there is no default, so pass `--loops` (or the env var) if this install keeps a loop catalog.

The corpus is `{ window, sessions[], frustrations[], skillGaps[], registries[], warnings[], missing[], sources }`. Each frustration is `{ date, rating, kind, note }`, with `rating: null` on an unrated complaint-class row; rated rows sort first, lowest rating first.

## Gotchas

- Paths are discovered, not assumed. The tool resolves stores via flags/env/root, so it works across installs; do not hardcode a home directory.
- A large work store makes the session list long, not the analysis better. The default 45-day window is the lever — widen it deliberately, and expect the cluster step to carry the cost.

## Output format

Each cluster is classified as one of:

- **BEHAVIOR-FEEDBACK** — verbosity, scope misreads, reminder cadence. Not a skill; route to memory/preferences. Exclude.
- **COVERED** — an existing skill/loop/intent genuinely handles the *discipline*, confirmed against its body as the Ideal State requires.
- **GAP** — recurs (severity-weighted; a high-severity repeated pain qualifies even below ~3) and uncovered, including a discipline gap (state modeling, error handling, migration safety) under a topic a build/test skill nominally covers.

The report:

```
## Skill-gap scan (last N days, M sessions; frustration store: present/absent)
### Gaps worth building
- <Name> [confidence: both|one] — <desc>. Evidence: N sessions, K frustration signals, G skill-gap detections, recurring failure = "<...>". → CreateSkill?
### Covered (verified against bodies, no action)
- <theme> → <skill/loop/intent>
### Behavior-feedback (route to memory, not a skill)
- <theme>
### Recommendation
<1-2 sentences>
```
