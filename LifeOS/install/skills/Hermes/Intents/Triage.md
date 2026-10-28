# Triage

A classified report of every way Hermes sidecar tasks have been dying over a time window, worst first, each with a root cause and a concrete fix.

## Ideal State

- Every failure class carries its count and severity from the tool output, never estimated.
- The root cause of each high-severity class is verified by tracing at least one representative session for it.
- Every class carries a concrete fix, honest about ownership: policy shapes change in `Policy.ts` + re-mount; soul content changes in `RenderSoul.ts` sources + re-mount, and only for a real problem in the content, never to dodge a scanner match; upstream Hermes behavior gets reported, not patched.
- By-design blocks and defects are separated, and a rule firing on ordinary legitimate work (a hot rule, a retry loop, zero-shape taints on first-party traffic) is marked a false-positive candidate.
- Classes are ordered by severity × count, and a single upstream cause that explains multiple classes is named as one fix, not five.

## Anti-criteria

- Never recommends removing a guard block that enforces a standing LifeOS rule (e.g. the sidecar voice-notification deny); recommending their removal is a triage failure.
- This intent reports; it changes nothing. Fixes are proposed to the principal unless already explicitly authorized.
- Upstream Hermes behavior is never patched.

## Output format

One entry per failure class, worst first: count and severity, root cause, fix, by-design or defect.

## Tool contract

```bash
bun ~/.claude/LIFEOS/HERMES/Observe.ts failures --days 7 --json   # the classified sweep
bun ~/.claude/LIFEOS/HERMES/LogAnalysis.ts --days 7 --json        # guard-rule detail when guard-block is a top class
bun ~/.claude/LIFEOS/HERMES/Observe.ts trace <session-id>         # drill into a representative session per class
```

### Intent-to-Flag Mapping

| User says | Flags |
|-----------|-------|
| (default), "this week" | `--days 7` |
| "today", "last night" | `--days 1` |
| "this month", "since it broke" | `--days 30` |
| "show me the raw data" | `--json`, quote it |
