# Checkup.ts

Gathers every signal about one app into one read-only bundle for the Checkup intent.

```
bun Checkup.ts <repo> [--isa <path>] [--since 14d] [--name <alias>]... [--json]
```

| Flag | Meaning |
|---|---|
| `<repo>` | The app's repo root. |
| `--isa <path>` | The ISA, when it is not `<repo>/ISA.md`. |
| `--since <n>h\|d\|w` | Signal window for git, Vigil and Errata. Default `14d`. |
| `--name <alias>` | Another name the app is logged or monitored under; repeatable. The ISA's `slug`, `project` and the repo folder name are always used. |
| `--json` | The full bundle instead of the one-screen summary. |

Sources: `IsaCheck.ts bar` and `write-probes`, `ISAGate.ts`, git, `Inventory.ts sync`, the Bunker monitor state, `Vigil.ts list`, `Errata.ts list`, `Achilles.ts list` (open findings only). Each runs as its own process with a two-minute timeout. A source that fails is listed under `unavailable` and never read as clean.

Signals are matched by whole-word name or repo path, so read each one before acting on it.

Exit codes: 0 gathered, 2 bad input.
