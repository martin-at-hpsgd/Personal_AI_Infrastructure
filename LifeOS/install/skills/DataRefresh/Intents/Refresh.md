# Refresh

Bring one target, or the whole fleet, current: repull sources, update the source-of-record dataset, rebuild the site payload, and (when elected) deploy and live-verify.

## Ideal State

- Every touched target's data files carry fresh `_meta` timestamps from its real upstream sources.
- Every touched target's linked dataset-of-record is updated with its own update log appended, and its site payload is rebuilt.
- When deploy was elected, the live site serves the new payload, proven by the freshness field advancing.
- The touched repos are committed: site repos have their data paths staged explicitly and are pushed per that repo's conventions, and public dataset repos go through a public-push scrubber when one is run.
- Every `⚠ headline prose may be stale` flag is acted on in the same motion: the dataset's SUMMARY/README rows carrying figures older than the data are updated by hand from the fresh data.
- A target's registry `notes` name the legs no script can run (new report editions to read, analysis to re-read, prose to correct); each one ran in the same motion as the scripted legs, and the report says which did and what each found.
- The report gives, per target, before → after record dates, deployed or staged, and live freshness when deployed.

## Anti-criteria

- `--deploy` is never passed unless the principal's ask covers publishing ("update the data sites", "refresh and ship"); "check/refresh the data" without publish intent stages only.
- No deploy leg runs after a fetch failure.
- A public-push scrubber block is never bypassed; it is surfaced to the principal.

## Safety gates

`--deploy` publishes to production. When in doubt, stage and report the diff.

## Tool contract

```bash
bun ~/.claude/skills/DataRefresh/Tools/Refresh.ts refresh <target|--all> [--deploy]
```

- Fetch failures exit nonzero, name the failing source, and always suppress the deploy leg.
- It leaves data changes uncommitted by design: commit and push per that repo's conventions (private repos push directly; public dataset repos pass your public-push scrubber, if you run one).

## Gotchas

- **The tool never edits prose.** Dataset summary/README headline figures are flagged (`⚠ ... headline prose may be stale`) for the DA to update by hand — deterministic code must not rewrite narrative claims.
- **Live verification needs settle time.** The deploy leg polls the verify URL up to 60s for the freshness field to advance past its pre-deploy value (a newer number, date or later string; a change to an older or unrelated value does not count); a "did not advance" or "no pre-deploy value" warning means verify manually, not that the deploy failed.
- **A refresh with zero upstream changes keeps the same record dates.** `pulled: X → X` with fresh `_meta` timestamps is success (sources re-checked, nothing new published), not a silent failure.
- **Numeric data can false-positive a push scrubber.** Long numeric strings occasionally match a scrubber's pattern. That is a surface-to-principal moment, never a pattern edit.
