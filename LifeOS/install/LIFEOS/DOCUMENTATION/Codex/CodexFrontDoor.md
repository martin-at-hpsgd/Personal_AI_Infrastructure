---
last_updated: 2026-10-24T00:00:00-07:00
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.0.10
---

# Codex Front Door — the same LifeOS, opened from Codex CLI

> **What it is.** A second front door onto a LifeOS install, opened from
> OpenAI's Codex CLI. The Codex home is a mirror of the install: symlinks and
> one generated file. Same constitution, same identity, same USER data, same
> skills, same hook guards, same memory.
>
> **What it is not.** A port. Nothing is copied, nothing is translated by hand,
> and nothing under `LIFEOS/CODEX/` knows what is in the doctrine. When the
> Claude side changes, the Codex side has already changed.

## Why a mirror rather than a port

The first Codex port (2026-07, refreshed 2026-09-06) copied the tree and then
guarded the copy against the original: a snapshot of the system prompt, a
template USER directory, 157 copied skills with shortened descriptions, 98
copied hooks with none registered, and a PreToolUse guard that denied any
command mentioning the real install. Every copy drifted by the next morning.

The mirror inverts it. There is one LifeOS; Codex is another way in.

```
$CODEX_HOME/
├── AGENTS.md            generated  ← substrate header + system prompt + CLAUDE.md (selective imports)
├── LIFEOS        →  <install>/LIFEOS        (LIFEOS/USER → the real USER dir, through the install's own link)
├── hooks         →  <install>/hooks
├── commands      →  <install>/commands
├── agents        →  <install>/agents
├── lifeos-codex  →  <install>/LIFEOS/CODEX
├── skills/
│   ├── .system/         Codex's own bundled skills, untouched
│   └── <Name>/          one view per skill: a real dir of entry symlinks into <install>/skills/<Name>,
│                        runtime data (node_modules, state, cache…) left out of the scanner's walk
├── hooks.json           one Bridge.ts entry per Codex lifecycle event
└── config.toml          three managed lines; everything else byte-preserved
```

`bun LIFEOS/CODEX/Mount.ts` converges a Codex home onto that shape; `--check`
reports drift and changes nothing. It also runs, detached, on every Codex
session start, so AGENTS.md and the skill symlinks are at most one session
stale.

## The three layers, and where each lands

| Claude Code carries it as | Codex carries it as |
|---|---|
| `--append-system-prompt-file LIFEOS_SYSTEM_PROMPT.md` | the middle of AGENTS.md (frontmatter stripped) |
| `CLAUDE.md` with `@`-imports (identity, TELOS, projects, operational rules) | identity and operating rules inlined; architecture, TELOS details, and project inventory use explicit live-source routes |
| `settings.json → hooks` (command + http registrations) | `hooks.json` → `Bridge.ts <Event>` → the same registrations, read from `settings.json` at runtime |
| `skills/<Name>/SKILL.md` | generated read-only view with a compact catalog description and the complete original description/body; other entries are symlinks |
| the LifeOSHooks function-hook plugin (🧠/⚙️ chips, ascent strip) | not available; the system prompt's "Fallback, no plugin" paragraph is the operative regime, stated in the AGENTS.md header |

`model_instructions_file` is deliberately **not** used. Per the Codex config
reference it is a "replacement for built-in instructions" — it would delete
Codex's own operating guidance. AGENTS.md sits on top of the base
instructions, which is the append Claude Code does.

Two budgets are set explicitly. `project_doc_max_bytes` truncates AGENTS.md
silently at its default, so the mount reserves room for the complete doctrine and imports. `skills.max_context_tokens`
is set too, but it can only *lower* Codex's window-derived cap (2% of the
context window), never raise it: with 160-plus skills every description in Codex's
own catalog can be truncated to roughly its first sentence. Each source skill
therefore carries a concise `metadata.short-description`. The native catalog
ignores that metadata directly (verified with a synthetic skill), so the mount
projects it into the generated view's `description` field. The complete original
description is retained in the view body, followed by the unchanged workflow
body. Claude Code continues to read the original source description.

The native catalog is the single startup skill index. AGENTS.md requires
reading a matching skill's complete description before use, and searching
source descriptions when the concise summary leaves routing ambiguous.
Full USE WHEN and NOT FOR clauses remain in every generated skill view;
they are not repeated across every model call in AGENTS.md. Identity,
global operational controls, and constitution remain fully loaded.
Domain instructions remain verbatim behind mandatory source routes in the
shared CLAUDE.md and OPERATIONAL_PREFERENCES. The architecture summary, detailed TELOS,
and project registry are loaded on demand in both harnesses. Each route
requires reading its live source when relevant or uncertain, including after
compaction. New imports default to full inclusion. `Render.test.ts` checks
preservation and routing coverage. `SystemContext.ts` provides live source
discovery, literal search and exact section reads across core context and
installed skills. See `Skills/ProgressiveContext.md` for delivery and rollback.
`SkillCatalog.test.ts`
checks source/view preservation and summary lengths; the native catalog probe
requires every source summary to appear completely, so future catalog budget
changes are detected rather than silently clipping routing text.

The skill scanner also has a traversal limit, and one skill's `node_modules`
alone pushed a whole-directory symlink past it. Each skill is therefore
mounted as a *view*: a real directory holding one symlink per top-level entry
of the install's skill dir, with runtime-data segments (`node_modules`,
`state`, `cache`, profile data) left out. A skill's own tools still resolve
`import.meta.dir` through the symlink to the real tree, so nothing they run
changes; the scanner just never walks the dependencies.

Codex clamps SessionEnd hooks to 3 s, so the bridge fires the SessionEnd
registrations detached and returns immediately; they produce nothing Codex
consumes.

## The bridge

`Bridge.ts` is the only Codex-specific code path. For each event it:

1. reads Codex's stdin payload and shapes it the way Claude hooks expect — a
   string `transcript_path` (Codex's is nullable and not Claude-shaped, so the
   bridge keeps a Claude-shaped shadow transcript per session in the state
   dir), and `apply_patch` fanned out into one synthetic `Write` / `Edit` /
   `Bash rm` per file so the file guards, ISASync and the checkpoint hook see
   a `file_path`;
2. applies the install's `settings.json` `permissions.deny` and
   `permissions.ask` rules to each shaped input (these are not hooks in
   Claude, so without this step a Codex session would be freer than Claude on
   exactly the deterministic controls: env reads, `rm -rf` of the install,
   curl-pipe-sh, force pushes, writes under `/etc`). A match is a deny with
   the rule named; an `ask` rule also denies, because Codex sessions here run
   auto-approved and there is no one to ask;
3. selects the registrations for that event from the install's
   `settings.json` — Claude matcher semantics (full-match regex on tool name,
   session source, compaction trigger or agent type) — minus a named skip
   list;
4. runs command hooks with the install's env (`LIFEOS_DIR`, `LIFEOS_CONFIG_DIR`,
   `PROJECTS_DIR`, `CLAUDE_PROJECT_DIR=cwd`, `LIFEOS_HARNESS=codex`; never
   `CLAUDE_CONFIG_DIR`, which would redirect writes) and HTTP hooks by POST to
   the Pulse endpoints in `allowedHttpHookUrls`;
5. folds the answers into one Codex decision: a deny or block from any hook
   wins; contexts concatenate; plain stdout becomes `additionalContext` on the
   context-bearing events; `continue:false` and `systemMessage` pass through;
6. appends one metadata record (event, tool, hooks run, decision, ms, faults —
   never prompt text, tool input or output) to `LIFEOS/USER/CODEX/events.jsonl`.

Fail open on adapter faults, fail closed on decisions: a hook that crashes,
times out or prints garbage is logged and skipped; only an explicit deny/block
propagates. The one exception is a registration marked `onFailure: "block"`
(Claude Code 2.1.295): if that hook cannot start, times out or exits with a
code other than 0 or 2, the bridge turns the fault into a block, the same as
on the Claude side. The bridge never emits `allow` on its own — allow is the absence
of deny, so a silent hook can never widen Codex's sandbox. Codex documents
PreToolUse the same way LifeOS does: a guardrail on top of the sandbox and
approval policy, never a replacement.

Two checks are built into the bridge because nothing on the Claude side
carries them: the Stop format check (closer last, CHANGE paired with VERIFY;
no banner since system prompt v3.16.0; FormatGate keys on a plugin stamp that
never exists here) and the prompt-submit secret-shape check (the Claude Safety hook
frames external content but does not block a pasted private key; the previous
port did, and the control is kept).

### Event map

| Codex event | Claude registrations run | matcher subject |
|---|---|---|
| SessionStart | SessionStart (LoadContext, FreshnessCache…) | `source` |
| SessionEnd | SessionEnd (learning, cleanup, integrity…) | `reason` |
| UserPromptSubmit | UserPromptSubmit (memory turn, nudges, drift, time…) | — |
| PreToolUse | PreToolUse (registered hooks, plus the bridge's mirror of the native `permissions.deny` / `ask` rules) | `tool_name` |
| PostToolUse | PostToolUse (ISASync, checkpoint, observers, loggers…) | `tool_name` |
| PermissionRequest | PermissionRequest (Safety) | `tool_name` |
| PreCompact / PostCompact | PreCompact / PostCompact | `trigger` |
| SubagentStart / SubagentStop | SubagentStart / SubagentStop | `agent_type` |
| Stop | Stop (voice, ISA render, spend audit, StopGates, memory review…) + the built-in format check | — |

**Not mirrored, by design:** Claude events with no Codex counterpart
(`Notification`, `PostToolUseFailure`, `TaskCreated`, `ConfigChange`,
`StopFailure`); Claude-maintenance hooks skipped by name (SettingsBackport,
MergeSettings, HookHealer, KittyEnvPersist, TabState); the model-router hook (maintainer-side, not in the
public release; skipped for good, since Codex runs no model router); the Bash rewriter
(ContextReduction — deferred until Codex's `updatedInput` contract is probed);
`Read`-matcher hooks (Codex reads through the shell, so nothing fires); the
kitty tab, the shell statusline and the harness-drawn ascent strip (Codex's
native footer stands in).

### Tool vocabulary

Codex already reports its shell tool as `Bash` with `tool_input.command`, so
every Bash-matched Claude hook fires unchanged. `apply_patch` is the one
translation. `webrun`, `collaboration*`, `update_plan` and `view_image` pass
through under their own names and match only the catch-all registrations.

## Trust

The generated Codex substrate distinguishes agent completion notifications from shell session handles. Use notifications when available; a returned shell session handle may need the tool's wait operation. Long builds do not justify alternating sleeps, empty polls, and repeated full-log reads. Waiting guidance lives in `CODEX/Render.ts`.

Codex binds hook trust to the exact definition hash and skips untrusted hooks.
The mount writes `hooks.json` and never `[hooks.state]`: after a mount that
changed `hooks.json`, the principal opens Codex and reviews the definitions in
`/hooks`. Because the bridge reads registrations at runtime, `hooks.json`
changes only when the bridge's own contract changes — a hook added for Claude
never triggers a re-trust.

## Voice and channels

The closer is spoken by the same `VoiceCompletion` Stop hook Claude uses,
through the Pulse VoiceServer. The notification-channel rule is unchanged: a
Codex TUI session inherits `TERM` and resolves to the desktop channel; a
session with no terminal identity (the desktop app, a scheduled run) resolves
to `headless` and stays silent.

## State and privacy

Bridge state lives in `LIFEOS/USER/CODEX/` (mode 0700, files 0600): the
telemetry log (`events.jsonl`), the shadow transcripts (`transcripts/`), harness evidence, and the voice id carried over from the
first port. The Codex home is as private as the install: CONSTITUTIONAL №3
applies to everything under it, including Codex's own session directories.

The first port is not deleted. The mount moves it to
`$CODEX_HOME/.lifeos-retired-<date>/` after relocating the two work dirs Codex
sessions had authored into `USER/MEMORY/WORK/` and the bridge state into
`USER/CODEX/`. Rollback is a reviewed restoration from that directory.

## Verification

```bash
bun test ./LIFEOS/CODEX                       # (source tree only; tests are not in the release payload) fixtures: patch fan-out, matchers, merge, real guards through the bridge, mount e2e
bun LIFEOS/CODEX/Mount.ts --check           # drift gate: exit 0 converged, 1 drift
bun LIFEOS/CODEX/Mount.ts --check --only catalog   # Codex's own renderer lists every install skill once
bun LIFEOS/CODEX/Mount.ts --check --only live      # one session in the last 24 h logged SessionStart, UserPromptSubmit, PreToolUse and Stop, and an apply_patch edit fanned out and reached the bridge's permission mirror (`Bridge.permissionMirror` named in its telemetry record; the mirror is named whenever it judged an input, matched or not)
```

The probeable criteria live in `LIFEOS/CODEX/ISA.md` (maintainer-side; does not ship); `bunker.config.ts` adopts
the front door as a `cli` app so the same harness watches it.

## Front doors retired

The Pi front door (`LIFEOS/PI/` (not in the public release), the generated shim, `APPEND_SYSTEM.md` and the hook bridge) was retired 2026-10-24 on the principal's word ("remove it"). Its code, its ISA and `Pi/PiFrontDoor.md` are deleted, and the install's retirement registry (`skills/LifeOS/install/RETIREMENTS.json`) removes the files from existing installs on upgrade. Codex and Claude Code are the two remaining front doors.
