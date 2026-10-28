# Survey

A read-only map of a target (file, skill, tool, subsystem or repo): what it is for, everything that depends on it, and every element classified with evidence. This is the record Propose builds on.

## Ideal State

- The survey states the target's purpose, taken from its ISA when one exists (path cited) or else derived from its docs, callers and git history, with each source cited. Where purpose had to be inferred, the survey says so.
- Every dependent is listed with `file:line` or a config key: code callers and imports, string references (settings and hook registrations, launchd plists, workflow definitions, skill routing tables, dynamic imports, spawned commands), docs that describe it, and tests that exercise it. Each search that ran is listed, including those that found nothing.
- Every element of the target (section, function, file, option, rule) carries exactly one class. **load-bearing:** a named dependent or ISA criterion relies on it. **duplicate:** another element does the same job, named. **dead:** no dependent, with the searches that showed it. **cruft:** stale comments, history prose, unused config or leftover scaffolding. **over-abstracted:** an indirection with one caller or one implementation. **unknown:** the evidence does not settle it.
- A behaviour baseline is recorded before any change exists: the test or probe commands that cover the target, their pass counts, and any behaviour no test covers.
- The survey is written to `LIFEOS/MEMORY/WORK/{slug}/simplify/survey.md` with non-empty `PURPOSE`, `DEPENDENTS`, `FINDINGS` and `BASELINE` headings, so Propose can verify it.
- A Survey-only run (a read-only analysis that calls this skill, or a request that says survey only) is finished when `survey.md` is written: it proposes and applies nothing, and its reply gives the survey path, the count of elements in each class, and each dead, duplicate, cruft and over-abstracted finding with its evidence, so the calling analysis can fold the findings into its own report without re-reading the target.

## Anti-criteria

- Never edits, creates or deletes a file in the target. Findings are reported, never applied.
- Never classifies an element as dead or duplicate from a single code search. String references, config registrations and other repos that call the target count as dependents.
- Never calls an element cruft because it looks old or odd. An element nobody can explain is unknown, and unknown elements stay.
- Never surveys the wrong scope. When the target is ambiguous it asks at most three questions, with a "proceed" override. When the target is workable but ambiguous, it surveys the best reading and says so in one line: "⚠️ Picking X over Y because R; redirect if wrong."

## Tool contract

Run from the target's repo root.

```bash
rg -n --fixed-strings "<symbol, filename or skill name>" <repo roots>   # every root that could call it, ~/.claude included
git log --follow --format='%h %ad %s' --date=short -- <path>          # why each piece arrived
git log -S"<symbol>" --format='%h %ad %s' --date=short                 # when a symbol's callers came and went
bun ~/.claude/LIFEOS/TOOLS/ReferenceCheck.ts --orphans --shipped-paths --json   # inside ~/.claude: orphans and broken refs, including spawn and dynamic-import specifiers
```

The baseline uses the target's own test command, from its ISA Test Strategy or its package scripts. Under `bun test`, always prefix the path with `./`.

## References

- `skills/Trim/SKILL.md`: the context-file specialist this skill hands always-on files to.
- `~/.claude/LIFEOS/DOCUMENTATION/ISA/ISAFormat.md`: where a target's ideal state and criteria live.
