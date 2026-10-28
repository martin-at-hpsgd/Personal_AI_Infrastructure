# Detect

A tiered flag report of the AI-isms in a text, with no rewriting. Use it when the writer wants to see what's flagged and decide themselves, when the flagged patterns might be intentional, when auditing published content or someone else's writing, or for a quick scan without a full rewrite.

## Ideal State

- **Context profile:** detected and named, as in rewrite.
- **Audit:** every AI-ism identified, grouped by severity (P0, P1, P2). Include the narrator's aside (AIWritingPatterns § Semantic patterns): search everyone / nobody / no one / anyone / people / "the way you" / "as anyone" / ordinary / usual and flag each place the writer leaves the specific case to speak for people in general.
- **Assessment:** each flag marked as a clear problem or a judgment call, since some AI-associated patterns are effective writing, with which to definitely fix and which might be fine in context.
- Protections are reported too: every catalog match left alone (literal, quoted, attributed, domain-valid) is listed with its reason, so the writer sees what was checked, not just what was flagged.

## Anti-criteria

- The text is never edited; a rewrite is the `Rewrite` intent's job.
- A judgment call is never presented as a must-fix.

## Output format

```
**Profile:** [detected profile] | **Severity pass:** [P0+P1 / full]

**P0 — Credibility killers:**
- "[offending text]" — [category] — MUST FIX

**P1 — Obvious AI smell:**
- "[offending text]" — [category] — [fix / judgment call]

**P2 — Stylistic polish:**
- "[offending text]" — [category] — [fix / fine in context]

**Assessment:**
[overall health: clean / minor issues / needs rewrite]
[which flags are clear problems vs. intentional choices]
```

## References

- `References/CompleteGuide.md` § References — the patterns catalog and voice files the audit reads, loaded with this intent by the `detect` bundle.
- Standalone detection with no rewrite intent routes to the public **DetectAI** skill (SKILL.md § Intent Routing).
