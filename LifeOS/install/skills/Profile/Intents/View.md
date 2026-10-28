# View

Display the user's profile in a formatted, readable way.

## Ideal State

- When `~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` exists, the full profile is displayed in its own format: every section of the file, in file order, as written, followed by its convention, `last_updated` and `last_updated_by`, `last_reviewed` (or "never") and `last_reviewed_by`, and its review age against the 90-day window, in the shape under Output format.
- When `last_reviewed` is missing or older than 90 days, the overdue-review warning is appended; staleness is judged from `last_reviewed`, not `last_updated`.
- When the file does not exist, the user gets the no-profile message pointing to the Edit intent or the Interview skill.

## Anti-criteria

- Never modifies the file: View is a read-only operation.
- Never summarizes or truncates the profile: the full profile is shown.

## Output format

When the file does not exist:

```
No user profile found. Create one with the Edit intent ("edit profile") or the Interview skill.
```

When the file exists:

```
════ LifeOS | USER PROFILE ═══════════════════════

[every section of the file, in file order, as written]

---
Convention: [convention] | Last updated: [last_updated] by [last_updated_by]
Last reviewed: [last_reviewed, or "never"] by [last_reviewed_by]
Review age: [days since last_reviewed] / 90 days
```

The overdue warning (90 days is this file's window in `TelosFreshness.ts`):

```
⚠️ Profile is overdue for review ([X] days since last review, or never reviewed). Review it with the Interview skill.
```
