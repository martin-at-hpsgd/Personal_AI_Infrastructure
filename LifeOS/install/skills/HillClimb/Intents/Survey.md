# Survey

Find the steepest hill in the whole system when no target is named, then climb the one the principal picks.

The system-wide view of what to improve in LifeOS lives in Review (`LIFEOS/REVIEW/`, Pulse `/review`), which pools this survey's hills with every other source and asks the principal for at most three decisions a week. Run Survey directly only to pick a climb; Review is where the system decides.

## Ideal State

- A ranked list of hills, each with its score, the intent that climbs it, the source it came from, and the evidence in plain words.
- Every survey source that could not be read is named with its reason.
- Hills that share one root are grouped and shown once, with the count. One example is a skill whose suite fails and that also has complaints.
- The principal picks a hill, or says "climb the top one", and the matching target intent starts with that hill's evidence as its first misses.

## Anti-criteria

- A survey source that could not be read is never read as no pain.

## Inputs

Sources: Errata per-skill complaint rates and false passes, Errata retire candidates, the Most-broken rules table in the latest Errata v4 report, Assay suites (failing, weak, never run, judge-heavy), applied Upgrades never verified, and closed climbs older than a week with no verify.

## Safety gates

- Present the ranking and stop for the pick. Picking the hill is direction, and direction is the principal's call.
- Before naming a broken-rule hill, read the rule with `bun LIFEOS/ERRATA/Errata.ts v4 rules show <rule-id>`. Rule ids are hashes, so say what the rule says.

## Tool contract

```bash
bun ${LIFEOS_SKILL_DIR}/Tools/HillClimb.ts survey [--since YYYY-MM-DD] [--top N] [--json]
```

### Intent-to-Flag Mapping

| User says | Flag |
|---|---|
| (default) | last 30 days, top 15 |
| "this week", "since Monday" | `--since <date>` |
| "everything", "the full list" | `--top 100` |
