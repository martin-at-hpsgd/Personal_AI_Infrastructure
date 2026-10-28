---
name: Vitals
evals:
  manual:
    reason: "a live performance diagnosis must be checked against the actual Mac state and the reported symptom"
    falsifier: "the reviewer finds a reported bottleneck absent from collected evidence or a diagnosis that does not address the supplied symptom"
metadata:
  short-description: "Diagnose macOS CPU, GPU, memory, energy, thermal, disk, and startup pressure through read-only tools. Excludes network and deployed-site diagnostics."
version: 1.1.1
description: "macOS performance diagnostics via a read-only CLI: CPU/GPU/memory hogs, throttling, swap, disk. USE WHEN mac slow, system slow, what's slowing down my mac, computer is slow, what's eating CPU, CPU usage, GPU usage, what's using the GPU, memory pressure, RAM usage, swap, runaway process, fans loud, mac running hot, thermal throttling, system health, check my mac, how's my system running, top processes, energy hogs, activity monitor, startup items, launch agents load, system taxed. NOT FOR network/wifi, deployed-app health, or security scanning."
---

# Vitals

Read-only macOS performance inspection: a deterministic CLI gathers the numbers, `Interpretation.md` turns them into a diagnosis instead of a data dump.

The tool is read-only by contract: it never kills, renices, unloads, or writes system state. Remediation is recommended to the operator, never executed by the skill.

The CLI is `bun ~/.claude/skills/Vitals/Tools/Vitals.ts <subcommand>`, with subcommands `check` (fast snapshot, under 1s), `hogs` (live per-process CPU/energy, ~3s), `gpu`, `memory`, `disk`, `thermal`, `startup` and `full` (everything, ~4s), plus the flags `--json` and `--top N`. Each intent's Tool contract names the calls it uses.

## Ideal State

- Every report is a diagnosis judged against `Interpretation.md`, verdict or culprit first, never a raw dump of numbers.
- When the operator names a symptom (a stuttering mouse cursor, loud fans, a lagging app), the report says which finding explains it, or says plainly that none of the collected evidence does.
- Normal macOS behavior that looks alarming (cache-filled memory, `kernel_task` cooling, Spotlight indexing) is named as normal, so the operator never chases a ghost.
- Nothing on the machine changes: every remediation is a specific command or setting offered for the operator's approval.
- The default path needs no sudo; the sudo leg runs only with the operator's consent.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **HealthCheck** | "how's my system", "check my mac", "system health" | `Intents/HealthCheck.md` |
| **FindCulprit** | "mac is slow", "what's eating CPU/GPU/memory", "fans loud" | `Intents/FindCulprit.md` |
| **DeepDiagnosis** | "full diagnosis", "deep check", chronic/recurring slowness | `Intents/DeepDiagnosis.md` |

| File | Read when |
|------|-----------|
| `Interpretation.md` | any intent: thresholds, known-process table, diagnosis shape |

## Data & Config

User customizations at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Vitals/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`) override the defaults when that directory exists.

## Gotchas

Provenance for the first four: live probes during the 2026-08-13 build.

- **`top`'s first sample is garbage**: its CPU% is cumulative since boot. The tool runs `-l 2` and parses the second sample, so keep that even though it costs ~3s.
- **`ps -m` does not reliably sort by memory** on modern macOS. A live probe listed a larger process below a smaller one, so the tool sorts in code; keep it that way.
- **`top -l` truncates command names** (~16 chars) regardless of COLUMNS in logging mode. Use the PID to identify the full process (`ps -p <pid> -o comm=`).
- **GPU via `ioreg -c IOAccelerator` works without sudo on Apple Silicon** (`Device Utilization %` in PerformanceStatistics) but is not guaranteed on every GPU. The tool degrades to an explicit unavailable-message, never a silent blank.
- **`pmset -g therm` may not report `CPU_Speed_Limit` on desktops**. `thermalInfo()` in `Tools/Vitals.ts` treats a missing key as not-throttled rather than erroring; no desktop reproduction is recorded.

## Examples

**Example 1: Something feels slow**
```
User: "My Mac is dragging, what's going on?"
→ FindCulprit intent
→ A named culprit with two evidence classes and a recommended action awaiting approval
```

**Example 2: Routine check**
```
User: "How's my system doing?"
→ HealthCheck intent
→ A one-screen 🟢/🟡/🔴 verdict with per-subsystem lines, abnormalities flagged against thresholds
```

**Example 3: Fans blasting**
```
User: "Why are my fans so loud?"
→ FindCulprit intent
→ When `kernel_task` tops the list, the report names the thermal cause behind the cooling response, not the process
```
