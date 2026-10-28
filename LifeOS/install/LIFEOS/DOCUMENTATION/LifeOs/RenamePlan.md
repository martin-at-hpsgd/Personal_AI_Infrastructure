---
last_updated: 2026-06-13T01:30:00Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.2.1
---

# RenamePlan — PAI → LifeOS

<!-- The title above quotes the RETIRED mark on purpose (public issue #1554,
     @loudoguno): a 2026-07-04 blind prose sweep rewrote this doc's own title
     to "LifeOS → LifeOS". Rename sweeps must exclude this file's title and
     retired-mark quotations — a rename doc has to be able to name the thing
     it renamed. -->


> The staged plan for renaming the system and (eventually) the public repo to **LifeOS**. Private rename tooling and privacy gates consume a machine-readable map; that map is outside the public release.

## The one rule

**A half-rename is a silent privacy regression, worse than breakage.** A scrub gate that greps for a token that no longer exists passes vacuously. Every rename stage therefore updates the private gates and their map in the same change.

## Status

| Wave | Scope | Status |
|------|-------|--------|
| **Casing standardization** | `LifeOS` prose standard (retire `Life OS`, keep `LifeOs` for PascalCase files only) | DONE 2026-06-13 (core files; fleet wave with rename-now) |
| **Rename-now (framing)** | Docs prose/branding (class 1), Pulse UI display strings (class 2 minus app bundle + logo asset), core identity files (system prompt, CLAUDE.md, thesis, architecture master) | DONE 2026-07-04 (RenameMap classes 1, 2 and 5) |
| **Rename-at-cut** | `LIFEOS/` dir + ~4K path refs (compat symlink), `PAI_*` env keys (read-fallback shims), the core management skill via CreateSkill, repo URLs (the GitHub rename IS the cut), mode banners + hook regexes, menubar app bundle, logo asset | DONE 2026-06-21 (migration ISA `20260620-pai-to-lifeos-rename-migration`): the `LIFEOS/` tree, `LIFEOS_*` env keys, `LIFEOS_SYSTEM_PROMPT.md` and `com.lifeos.*` agents are live, and the public repo is named `LifeOS` on GitHub; the mode banners were retired outright on 2026-07-11 |
| **Post-cut optional** | Code identifiers (194 occurrences) | DONE 2026-07-04 (RenameMap class 5, run ahead of the cut) |

## What changed now (framing wave)

- LifeOS is the primary identity in LIFEOS_SYSTEM_PROMPT.md, CLAUDE.md, LifeOsThesis.md, LifeosSystemArchitecture.md (+ regenerated ARCHITECTURE_SUMMARY.md) — zero rule/gate/template semantics changed; the three mode-banner literals stay byte-identical until the cut (pinned by OutputFormatGate + DriftReminder hooks).
- Pulse display strings say LifeOS; bundle name, asset paths, routes, env untouched.
- Docs subsystem intros tie each subsystem to the current→ideal-state loop.

## Cut preconditions (historical: the cut ran 2026-06-21)

1. The LifeOS sensor loop (R3–R7 from the 2026-06-13 MasterReport) is demonstrably running — the rename is then a formality, not a migration.
2. In-flight forks reconciled: the experimental fork checkouts, the skill-only shadow release (release root = `LifeOS/` skill only, no full `.claude/` clone and no root `install.sh`), 5.0.0/5.1.0 shadow releases.
3. Private scrub gates read the rename map programmatically.
4. Rehearsal in a `CLAUDE_CONFIG_DIR` clone passes its migration ISA (per-path probes: launchd agents alive, symlink chain intact, two-repo sync green, statusline rendering, Pulse healthy).
5. GitHub rename redirect verified (stars + clone URLs survive); never create a new repo named LifeOS afterward.

## Cut-day runbook (historical summary of the 2026-06-21 cut)

1. Freeze: no other sessions; checkpoint commit both private repos.
2. Atomic GitHub rename of the public repo (separate decision/moment from the private-tree changes; public repo content changes remain out of scope until then).
3. Private tree: `LIFEOS/` → new dir name in one operation + `LifeOS → <new>` compat symlink; env shims in; launchd plists rewritten + kickstarted; settings.json paths swept; banners + hook regexes + tests changed in one coordinated commit.
4. Sweep classes 6/7 (repo URLs, core management skill rename via CreateSkill).
5. Probe pass: migration ISA per-path probes + `bun test` (hooks/ cwd) + Interceptor screenshot of Pulse + iMessage smoke + a probe on every LifeOS worker machine in the fleet.
6. Shadow-release restage + 14 gates against the renamed tree before any future public publish.
