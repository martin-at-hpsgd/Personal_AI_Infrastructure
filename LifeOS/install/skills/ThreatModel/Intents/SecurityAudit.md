# SecurityAudit

Run the full security audit, or read the latest one, and answer "how exposed am I right now?".

## Ideal State

- The principal gets one line first: open critical and high findings, coverage, and the direction since the last audit, taken from the report's `Exposure:` line.
- Then what changed and which finders did not run.
- Every number comes from a report written this run or named by its date, never from memory.

## Anti-criteria

- Never reports a count as complete when the report marks the comparison incomplete.
- Never shares targets or evidence outside the terminal; only counts and entry ids leave it.
- The audit never writes the Achilles registry, the estate register or TELOS: a risk changes through the RiskRegister intent, a finding closes through `achilles close`.

## Tool contract

- Full run: `bun LIFEOS/WORKFLOWS/workflow.ts run security-audit --json`. It runs every finder in `LIFEOS/USER/SECURITY/AUDIT/finders.json` in turn, then writes the report under `LIFEOS/USER/SECURITY/AUDITS/` and emits to Vigil. The same workflow runs weekly on its own (`com.lifeos.wf.security-audit`).
- Plan only: `bun LIFEOS/TOOLS/SecurityAudit.ts run --dry-run --json` lists the finders and which of them run now.
- Latest report: the newest `*.md` in `LIFEOS/USER/SECURITY/AUDITS/`, with its `.json` summary beside it.

## Gotchas

- Coverage is finders that ran over every finder in the manifest. A skipped finder (continuous, manual, unbuilt) lowers it on purpose.
- The report is private (USER tree).
