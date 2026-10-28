---
name: ic
description: Full-system integrity check — file references, version anchors, hook registration + wiring, hooks-alive (main sessions actually receiving injections), carrier facts, replay corpus, CLAUDE.md @-imports, skills, intents, retired tokens, gate counts, spinner tips and verbs, command/agent frontmatter. Deterministic, under a minute (checks run concurrently), and it writes integrity stamps unless --no-stamp; --deep adds a workflow agent sweep. Then runs the documentation update with what it found and fixed as input, unless --no-ud or --section.
argument-hint: '[--deep] [--verbose] [--json] [--quiet] [--section <name>] [--no-stamp] [--serial] [--since-tag] [--run-id <id>] [--no-ud]'
version: 1.2.1
---

# /ic — Full-System Integrity Check

Thin invoker. The single source of truth for what this check covers, blocking vs non-blocking rules, and the deep sweep is the **IntegrityCheck** intent of your release skill (the skill that owns shadow releases and the docs-update intent).

**Default (deterministic, under a minute, every check in its own concurrent worker; it writes `last-run.json`, a `runs.jsonl` row and Vigil events on every full run, and `last-pass.json` on a clean one, unless `--no-stamp` is passed; a `--section` run writes nothing):**

```bash
bun ~/.claude/LIFEOS/TOOLS/IntegrityCheck.ts $ARGUMENTS   # minus --no-ud, which is this command's flag, not the tool's
```

**Then the documentation update, every run but `--section` and `--no-ud`:** after the verdict and any fixes, run the DocumentationUpdate intent once with this run's icContext (findings, fix paths, every file `/ic` changed, contextual findings, change window), so the docs catch up with what `/ic` fixed. The exact hand-off is the IntegrityCheck intent's Step 3.

Exit codes: 0 clean / 1 blocking / 2 scan error. Exit 2 blocks like exit 1. Orphans block: an unacknowledged orphan workflow is a blocking finding, and so is a guard-count drop until an `--accept-drop` run on the principal's yes. Report the verdict (CLEAN or N BLOCKING) and, on any blocking finding, the specific broken items with their fix paths.

Flags: `--json` structured output · `--quiet` findings only · `--section <name>` one check, never stamps · `--no-stamp` writes no stamp file at all · `--serial` runs the checks one after another (the parity reference) · `--since-tag` change window from the last `v*` tag · `--run-id <id>` recorded in every stamp · `--accept-drop` rewrites the guard-count snapshot, only on the principal's yes.

The report opens with a **Change window** — last-run timestamp + areas touched in both repos since. After the tool pass, do a focused contextual review of the top churned areas (judgment: a subsystem rework earns a look, mechanical churn like MEMORY logs does not): do the area's docs/README/ISA still describe what is there now; do the routing surfaces that point into it (CLAUDE.md, PROJECTS.md, the architecture summary, SKILL.md files) still match its shape; did the change orphan or relocate anything the deterministic pass cannot see (renamed dirs still referenced by prose, retired components still listed as live)? Report those findings beside the deterministic verdict; this is a focused read, never an agent sweep. Every full run without `--no-stamp` is stamped to `MEMORY/STATE/integrity/last-run.json` + `runs.jsonl` automatically.

**Deep audit (`--deep`):** the deterministic pass PLUS the deep sweep, run as a Claude Code Workflow — the tool never spawns agents itself. Invoke your release skill's **IntegrityCheck** intent with the argument `integrity check --deep` and follow it. On an install whose release skill has no such intent, `--deep` has nothing extra to run: the deterministic pass above is the whole check.

<!-- public issue #2016, @lgertel: the body names no private skill, so the release emitter's private-name filter ships this command -->
