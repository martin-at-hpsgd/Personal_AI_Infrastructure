---
version: 1.0.1
---

# Digital workers (more assistants beside your DA)

Status: `bun LIFEOS/TOOLS/SetupInventory.ts status` · optional

## What it does

A digital worker is a second, named assistant that works beside your main one. Your primary DA is the one you talk to. A worker is for a separate job you want to hand off, such as watching a mailbox or running a background task, with its own name and its own personality. The registry file is the roster: it lists every assistant on the install, which one is primary, and which channels each uses. The presets file holds the five personality starting points the DA wizard offers (`efficient`, `friendly`, `creative`, `mentor` and `worker`).

This is not the same thing as the model workers and agents the router launches for a task. Those come and go within a job. A digital worker is a lasting identity you named.

With one assistant you don't need any of this, and the system stays off. The roster ships empty and is filled in when you finish the DA wizard (see Identity.md), with your first assistant as primary.

## Fill in

Both files live in `LIFEOS/USER/LIFEOS_WORKERS/`. The usual way to change them is the wizard, which rewrites the registry for you:

```bash
bun LIFEOS/TOOLS/DAInterview.ts                          # a new DA; the first one registered becomes primary
bun LIFEOS/TOOLS/DAInterview.ts --update --da <name>     # revisit one DA by name
```

To add a worker, run the wizard again with a different name. Any assistant registered after the first is saved with the role `worker` and the channel `background`. Pick the `worker` preset for a task-focused assistant with little personality. The wizard writes that DA's files (`DA_IDENTITY.md`, `growth.jsonl`, `diary.jsonl`, `opinions.yaml`) to `LIFEOS/USER/DIGITAL_ASSISTANT/<name>/`.

To edit the registry by hand, keep this shape. The file ships with an example entry written as comments; to use it, remove the leading `# ` and move it under `das:`:

| Key | Meaning |
|---|---|
| `version` | Always `1`. |
| `primary` | The name of the one primary assistant. |
| `das.<name>.role` | `primary` for your main DA, `worker` for the rest. |
| `das.<name>.enabled` | `true` or `false`. |
| `das.<name>.created` | The date it was added, in quotes. |
| `das.<name>.channels` | A list such as `terminal`, `voice` or `background`. |

Use a simple lowercase name with letters and digits only, because the wizard strips everything else when it makes the folder name. Do not add a hand-written entry before you have run the wizard for your first DA: the wizard treats a non-empty registry as having a primary already, and would register your real first assistant as a worker.

## Accounts and secrets

The registry and presets hold no secrets. A worker needs credentials only when its job needs them, and those are set up for that job: the DA wizard leaves the voice id empty, and a worker that speaks needs `FISH_API_KEY` in `~/.claude/.env` and a Fish voice model like any other assistant (see Voice.md). Access to mail, calendars or other accounts is configured by the skill that uses it, never in the registry. See CoreConfig.md for where keys go and how to check one without printing it.

## Prove it works

```bash
bun LIFEOS/TOOLS/SetupInventory.ts status                          # the "Digital workers" row
rg -n "^primary:|^  [a-z0-9_]+:$" LIFEOS/USER/LIFEOS_WORKERS/_registry.yaml   # your primary and every registered name
```

On a fresh install the status row reads `optional-off`; that is correct while you run one assistant. After you have run the wizard, `primary:` should name your DA and each registered assistant should appear once. A `primary: ""` line means the wizard has not registered anyone yet.
