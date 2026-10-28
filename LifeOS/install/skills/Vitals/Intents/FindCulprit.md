# FindCulprit

"Why is my Mac slow right now?" — name the specific thing taxing the system, with evidence.

## Ideal State

- The report names a culprit, or says explicitly "nothing is actually wrong", with what the operator noticed and why it's normal.
- Every culprit claim carries two evidence classes per `../Interpretation.md` § Diagnosis shape: the process's live numbers AND a corroborating system signal.
- Known macOS background processes are identified as such (Interpretation.md § Known processes).
- The report ends with a specific recommended action per culprit, a command or setting change, offered for approval.

## Anti-criteria

- No culprit claim rests on the process's numbers alone without a corroborating system signal.
- The operator is never left to kill Spotlight indexing or kernel_task thinking it's malware.
- A recommended action is never pre-executed; the skill never kills, renices, unloads, or writes system state (SKILL.md: read-only by contract).

## Tool contract

```bash
bun ~/.claude/skills/Vitals/Tools/Vitals.ts hogs      # live CPU + energy, second-sample (~3s)
bun ~/.claude/skills/Vitals/Tools/Vitals.ts check     # system context: load, pressure, thermal, disk
bun ~/.claude/skills/Vitals/Tools/Vitals.ts gpu       # GPU utilization (no sudo)
```

### Intent-to-Flag Mapping

| User Says | Command |
|-----------|---------|
| "what's eating my CPU" | `hogs` |
| "what's eating my memory" / "RAM" | `check` (TOP MEMORY section) + `memory` |
| "GPU" / "graphics" / "fans on a video call" | `gpu` + `hogs` |
| "everything" / "slow and I don't know why" | `check` + `hogs` + `gpu` |
| "JSON" / scripted use | append `--json` |
