---
metadata:
  short-description: "View, edit, or reset the persistent principal identity and preferences loaded at startup. Excludes harness configuration changes."
name: Profile
evals:
  manual:
    reason: "whether an edit matches what the principal asked is a judgment about their intent, which no fixture holds"
    falsifier: "the reviewed identity file omits the requested change, contains an unapproved change, or a clear operation leaves retained profile data"
version: 1.1.1
description: "View, edit, or clear the LifeOS User Model (PRINCIPAL_IDENTITY.md) — persistent identity context loaded at session startup. Three intents: View, Edit (identity, goals, constraints, preferences), Clear (reset). Read by Algorithm OBSERVE and skills for personalization. USE WHEN profile, show profile, view profile, who am I, my profile, edit profile, update profile, clear profile, user model, PRINCIPAL_IDENTITY. NOT FOR settings.json or CLAUDE.md edits (use update-config)."
---

# Profile Skill

Views, edits, or resets the LifeOS User Model — the `PRINCIPAL_IDENTITY.md` file that holds persistent identity context and loads at the start of every session through the CLAUDE.md @-import. Three operations: View shows the current model, Edit updates its sections, and Clear resets it to a blank template (it never deletes the file). The Algorithm reads it when writing ISCs and choosing capabilities, and other skills read it for personalization, so this skill keeps that context visible and current in one place.

## Ideal State

- The identity file always exists and loads at startup; Clear replaces its contents and never deletes it.
- Every change touches only what the principal asked for, leaves the Memory-System Proposals queue to the memory curation loop, and bumps `last_updated` but never `last_reviewed`, so the freshness grade stays honest.
- Clear never overwrites the file without a verified backup and the principal's explicit yes.
- The file holds context about who the principal is, never executable directives (those belong in CLAUDE.md or the system prompt).
- Off-limits categories (health, relationship, financial details) enter the file only when the principal explicitly asks for them.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **View** | "profile", "show profile", "view profile", "who am I", "my profile" | `Intents/View.md` |
| **Edit** | "edit profile", "update profile", "change profile" | `Intents/Edit.md` |
| **Clear** | "clear profile", "delete profile", "reset profile" | `Intents/Clear.md` |

| File | Read when |
|------|-----------|
| `Setup.md` | first-time setup, a worked example of the identity file on made-up values, and the read-only proof commands |

## Data & Config

The User Model lives at `~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` (in a standard install `LIFEOS/USER` is a symlink to `~/.config/LIFEOS/USER`, which may be its own private git repo) as markdown with the `lifeos-freshness-v1` frontmatter (`LIFEOS/DOCUMENTATION/Freshness/FreshnessSystem.md`):

```yaml
last_updated: ISO-8601      # every write, any author
last_updated_by: <author>
convention: lifeos-freshness-v1
last_reviewed: ISO-8601     # principal review only; drives the staleness grade (90-day window for this file)
last_reviewed_by: <principal>
```

The Interview skill's ContextCheckin intent is the only flow that bumps `last_reviewed`; this skill's intents read the file on demand when it is viewed or edited.

The same frontmatter also holds the header facts that code reads, so a change to one of these is a change to the YAML key, never to prose:

| Key | Reader |
|-----|--------|
| `core` (`name`, `pronunciation`, `timezone`) | `getPrincipal()` in `hooks/lib/identity.ts`, as the fallback only: `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` `[principal]` wins for name, pronunciation and timezone |
| `voice_clone` | the model, through the header-mirror block (no code reader) |
| `preferences` | `getPrincipalPreferences()` in `hooks/lib/identity.ts` |
| `tech_stack` | `getTechStack()` in `hooks/lib/identity.ts`, its only source |

`LIFEOS/TOOLS/HeaderMirror.ts` copies these keys into a generated block in the body, because @-import strips frontmatter; `DerivedSync.ts` runs it on every hand edit.

The blank template (`Intents/Edit.md` § Output format) starts the file with four sections: Quick Reference, Worldview, Work Patterns & Communication, and Preferences. Users add their own sections over time, and the memory curation loop may keep an auto-append Memory-System Proposals queue at the bottom. Edit changes the sections that exist in the user's file; it does not impose the template's schema on it. First-time setup, a worked example and a read-only proof: [`Setup.md`](Setup.md).

## Gotchas

- Profile changes take effect next session (or after context reload), because the file is loaded at startup.
- A fact kept only in frontmatter is invisible to the model unless the header-mirror block carries it; edit the frontmatter, never the generated block. A fact that exists only in frontmatter can be denied by the DA in conversation, because the model never saw it.

## Examples

**Example 1: View the profile**
```
User: "show my profile"
→ Invokes View intent
→ Reads PRINCIPAL_IDENTITY.md and presents the current user model
```

**Example 2: Edit a section**
```
User: "update my profile — add that I prefer metric units"
→ Invokes Edit intent
→ Updates the Preferences section, bumps `last_updated` and `last_updated_by` (never `last_reviewed`)
```

**Example 3: Reset**
```
User: "clear my profile"
→ Invokes Clear intent
→ Confirms intent, backs the file up to ~/Downloads, then resets PRINCIPAL_IDENTITY.md to the blank template (the file stays; `last_reviewed` is removed so the freshness grade drops until the principal reviews it)
```
