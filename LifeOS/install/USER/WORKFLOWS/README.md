---
provenance: template
---

# WORKFLOWS

**Purpose:** The home of your workflow definitions. Everything LifeOS does on a schedule or on demand (reminders, follow-ups, recurring jobs, multi-step work) is one definition file here.

**What lives here:** One `<name>.workflow.yaml` per workflow. The name is lowercase words joined by hyphens. Steps can be code, a model call, a judgment-layer question, an agent or a human hand-off, each with a schema-checked contract. Create, check and run them with the `workflow` command:

```bash
bun LIFEOS/WORKFLOWS/workflow.ts help --json
```

**How it gets populated:** By you, or by asking your DA to "make a workflow for X" (the Workflows skill scaffolds, validates and schedules it). Do not create a second scheduler elsewhere; a job that this folder does not show is invisible to Pulse `/workflows`.

**Sample state for fresh installs:** This README and `statusline-refresh.workflow.yaml`, the every-minute refresher for the statusline's shared caches (tide, usage, weather and the rest). The statusline setup component installs its schedule; `bun LIFEOS/WORKFLOWS/workflow.ts list` shows it. Run history is written to `MEMORY/STATE/workflows/runs.jsonl` on the first run.
