# Upgrade

A tiered, evidence-backed upgrade report from the monitored sources and the system's own reflections, every recommendation grounded in verified current state.

## Ideal State

- The user is reading a report shaped exactly by `../References/OutputFormat.md`.
- **Every worthwhile new technique** from the monitored sources — Anthropic first, then creators, trending repos, and custom sources — is extracted with a quote or code block and mapped to the specific LifeOS file or component it would improve. What the best practitioners are actually doing, not links to where they said it.
- **Internal signal is present**: the reflection corpus has been mined (method: `MineReflections.md`), and where internal pain and external technique point at the same gap, the report says so — those are the strongest recommendations.
- **Security debt is present**: the open findings from the infra scanner's ledger (the command named by `securityFindingsCommand` in `user-sources.json` in CUSTOMIZATIONS; the section is omitted when none is configured) are read and reported in a **Security debt** section — one row per fix class (class, open count, worst severity, oldest age, the fix command), never one row per finding; 45 DNS records are one row. Any class whose worst severity is critical or high also appears in the 🔴/🟠 tier of Recommendations with the fix command as the action. Finding it is the scanner's job; this run's job is making sure it is on the list of things to fix. If the tool is absent or the endpoint is unreachable, the section says so and the run continues.
- **Recommendations are tiered by judgment**, not formula: 🔴 CRITICAL (a gap or breakage-risk the system should not be running with), 🟠 HIGH (clear capability or efficiency win), 🟡 MEDIUM (worthwhile when convenient), 🟢 LOW (awareness). Each recommendation is one the user can act on immediately. Only non-empty tiers print.
- **Model freshness is surfaced**: the report carries a **Model Freshness** section from the deterministic leg below — every dispatch lane checked against its vendor's live roster, plus any versioned model IDs hardcoded in code outside the registry. Models change constantly; a run that never checked whether we're on the latest is incomplete (principal directive 2026-08-15).
- **Dependency freshness is surfaced**: the report carries a **Dependency Freshness** section from the deterministic leg below — the frameworks LifeOS skills orchestrate (the pinned HyperFrames CLI, and any skill `Tools/` package with real dependencies) checked against npm latest. Same rationale as models: a run that never checked whether the toolchain is current is incomplete (principal directive 2026-08-16, after a skill-driven video framework was found three versions stale).
- **State is current**: seen-lists updated (`USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/youtube-videos.json`, `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/github-trending.json`; `Anthropic.ts` owns `USER/CUSTOMIZATIONS/SKILLS/Upgrade/State/last-check.json`), and the execution log has the run's entry.
- Before the report is delivered, every 🔴/🟠/🟡 recommendation is written as one record in the Upgrades store.
- The report carries a short `## 🔄 Registry Update Proposals` section proposing the integration (Algorithm capabilities row, SKILL.md description update, or a new skill via CreateSkill) when a CRITICAL/HIGH discovery is a stable, distinct, invokable capability the Algorithm should know exists; otherwise it states "No registry updates needed this cycle."

## Anti-criteria

- No recommendation without a Prior Status tag backed by file:line evidence gathered this run; nothing already implemented, already deferred by decision, or already rejected is re-recommended.
- No absence-claim earns a 🆕/CRITICAL tag unless the thing claimed missing was positively probed this run (grep/read for it), never inferred; internal synthesis inference is bound exactly as external findings are (SKILL.md § Gotchas).
- Claude Code internals are never recalled from memory: anything touching hooks, settings, slash commands, MCP, agent types, or the SDK/API is verified against the live surface.
- A slow agent is never re-fired, and a source that times out or dies never delays the report.
- Never hand-edit `models.ts` inside an Upgrade run beyond what `--sync` wrote.
- Never run `bun update` inside an Upgrade run; a newer npm version is availability, not approval.

## Inputs

To ground Prior Status tags, the run needs verified current state before synthesis — what the Algorithm, hooks, skills, and tools already do; what recent ISAs decided; what `MEMORY/KNOWLEDGE/REJECTED/` forbids; what `MEMORY/LEARNING/` corrections require. Where that state lives: `LIFEOS/ALGORITHM/LATEST` → the versioned spec, `hooks/`, `skills/*/SKILL.md`, `LIFEOS/TOOLS/`, `settings.json` (generated — see gotchas), recent `LIFEOS/MEMORY/WORK/` ISAs. The user's goals and stack (`USER/TELOS/`, `USER/PROJECTS.md`, recent work) rank findings: on-stack beats off-stack, and a recommendation that serves a stated goal or challenge beats one that's merely clever.

**Quick mode.** A single-source ask ("check Anthropic only") runs just that source's collection against current-state grounding and produces an abbreviated report under the same contract: every recommendation still carries Prior Status with evidence.

## Safety gates

- **Recommendations must not break existing skills, hooks, or workflows** — check compatibility before recommending adoption.

## Tool contract

- **The source sweep runs as a script, not as loose dispatches.** `~/.claude/workflows/UpgradeFanout.js` owns the deadline, the fail-open behaviour, and the return shape; invoke it by its registered name — `Workflow({name: "UpgradeFanout", args: {sources: [{key, model | agentType, prompt}], groundingBrief}})` (the Workflow tool registers every `workflows/*.js` under its `meta.name`). Each source's brief still lives here, because this file is the source of truth for what a source is and how it is fetched — the script only orchestrates. It returns `{findings, coverage, grounding, totals}`; the report is still written by me, since the output format is a voice contract a script can't hold. Two contract facts learned the hard way (2026-08-06): `args` arrives as an object or a JSON string depending on the harness build (the script parses both), and `AbortSignal` does not exist in the runtime.
- **Deadline is a per-stage ceiling, fail-open, enforced by the script:** ~4 minutes for the source collection, then a separate ~4 minutes for the grounding leg, which starts only after collection returns. The whole call can therefore run about 8 minutes (the script has no shared overall deadline; `workflows/UpgradeFanout.js` `DEADLINE_MS` applies to each stage). A source that times out or dies comes back in `coverage` with that status and is reported as `⏳ timed out` in Sources Processed. Never re-fire a slow agent.
- **Delegates get explicit lanes** per the operative model-selection rules: a source carries `agentType` (a roster agent, e.g. the web-capable OpenAI researcher) or a `model` alias, never both. The grounding leg stays schema-bound on the script's own agent; a worker wrapper returns free text and cannot hold file:line citations to a schema (Council probe, 2026-09-18). GitHub trending is inspiration-only — shortest budget, first to drop.

Sources, their commands and state files are the `SKILL.md` § Sources & Tools table; the fan-out size, `claude-code-guide` budgeting and the GitHub 422 rule are `SKILL.md` § Gotchas.

### Model Freshness (mandatory deterministic leg)

The full model upgrade across every vendor, including the ones with no public roster, is `Intents/Models.md`; this leg is its deterministic half, run on every Upgrade pass.

Two fast commands, no network fan-out, feed the **Model Freshness** report section:

```bash
bun ~/.claude/LIFEOS/TOOLS/UpdateModels.ts --check          # offline: stale/landmine Claude pins + agent frontmatter
bun ~/.claude/LIFEOS/TOOLS/UpdateModels.ts --cross-vendor --sync   # network: each CROSS_VENDOR lane vs its vendor's live roster; same-class newer → live-probed and written; cross-class → proposal
```

- `--cross-vendor` probes Google / OpenAI / xAI rosters with the keys in `~/.claude/.env` and reports per lane: `✅ current` · `🆕 NEWER` (with candidate IDs) · `❌ MISSING` · `alias` (vendor pointer, never rots) · roster-unavailable. The `📌` advisory lists versioned vendor IDs hardcoded in executable code outside the registry — the fix is a new `CROSS_VENDOR` lane the code imports (how the image-gen pins moved in 2026-09-03), never a manual version edit in the consumer.
- What `--sync` writes and what it leaves is `SKILL.md` § Sources & Tools, "Model moves". Each decision it leaves is a 🟠 HIGH recommendation carrying the exact one-line fix.
- A lane already at head is reported in Skipped Content as the proof the check ran, same as any other grounded finding.

### Dependency Freshness (mandatory deterministic leg)

Fast commands, no fan-out, feed the **Dependency Freshness** report section:

```bash
# Skill Tools packages with real deps: bun outdated in each dir that has dependencies
for f in ~/.claude/skills/*/Tools/package.json; do
  rg -q '"dependencies": \{.+\}|"dependencies": \{$' "$f" && (cd "$(dirname "$f")" && echo "== $f" && bun outdated)
done
# Frameworks skills orchestrate (registry below): pinned version vs npm latest
rg -o 'HYPERFRAMES_VERSION = "[^"]+"' ~/.claude/LIFEOS/TOOLS/HyperFrames/constants.ts
bunx npm view hyperframes version
```

- **Framework registry** (frameworks a skill drives but does not install as a `Tools/` dependency): **hyperframes**, pinned once for every video skill as `HYPERFRAMES_VERSION` in `LIFEOS/TOOLS/HyperFrames/constants.ts` and run through `bun x hyperframes@<pin>`. The bump happens in that one constant, and only after `bun test ./LIFEOS/TOOLS/HyperFrames` passes on the new version (its render tests are the probe). Add a row here when a new skill takes on an external framework.
- **Propose-not-auto, same as models.** A newer npm version is availability, not approval — surface stale installs as 🟡 MEDIUM (🟠 HIGH if a breaking major or a security release), with the exact bump command per project. A bump is verified by rendering or running that project's own probe after the principal accepts.
- Everything already at head goes in Skipped Content as proof the check ran.

### Persist to the Upgrades Store (mandatory)

One record per 🔴/🟠/🟡 recommendation, written before the report is delivered:

```bash
bun ~/.claude/LIFEOS/TOOLS/Upgrades.ts add --source upgrade-skill \
  --claim "<one-sentence recommendation>" \
  --current "<what the system does today>" \
  --recommendation "<the proposed encoding>" \
  --target "<hook|doctrine|rule|skill|settings>" \
  --confidence <0-1> --evidence "<source URL or report ref>"
```

The store dedups by claim hash — re-running a scan never double-writes. Prior-Status grounding gains a source: check `bun ~/.claude/LIFEOS/TOOLS/Upgrades.ts list --json` for already-rejected (🚫) or already-applied (💬) claims alongside the existing `MEMORY/KNOWLEDGE/REJECTED/` check. Records surface in Pulse `/upgrades`; the applied half lands in the Ledger via `CreateUpdate.ts --upgrade-id`.

## References

**Reference example of the canonical output shape:** `../References/ExampleReport.md`.
