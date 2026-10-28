# DetectInference

Finds the Claude and Codex logins already on the machine and writes `LIFEOS/USER/CONFIG/inference-vendor.json` from them. It checks which CLIs are signed in and never reads out or writes a credential.

```bash
bun Tools/DetectInference.ts                  # dry run: what was found and the file it would write
bun Tools/DetectInference.ts --apply          # write it (over the shipped template or its own earlier write only)
bun Tools/DetectInference.ts --apply --force  # also replace a hand-edited file
```

| Found | `default` | `fallback` |
|---|---|---|
| Claude and Codex logins | `anthropic` | `openai` |
| Claude only, or neither | `anthropic` | none |
| Codex only | `openai` | none |

Output is one JSON object: `detected` (per CLI: `installed`, `loggedIn`, `via` naming the evidence, never a credential), `target`, `wouldWrite`, `written`, `kept` (why a hand-edited file was left), and `loginHint` when no login exists.

Test seams: `LIFEOS_DETECT_HOME`, `LIFEOS_DETECT_CONFIG_ROOT`, `LIFEOS_DETECT_KEYCHAIN=off`.
