# RenderIdentity

Fills the identity placeholders (`{{PRINCIPAL_NAME}}`, `{{DA_NAME}}`, their full-name twins, the voice ids, `{{LIFEOS_VERSION}}`, `{{TIMEZONE}}` and the dotted prose forms) across an installed LifeOS tree, from the install's own `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml`, then checks the surfaces Doctor's `identity-placeholders` probe checks.

```
bun Tools/RenderIdentity.ts                     # dry run: what would be filled, nothing written
bun Tools/RenderIdentity.ts --apply             # render; scaffold names are left for the Interview
bun Tools/RenderIdentity.ts --apply --strict    # render, and fail unless the identity is complete
```

| Flag | Meaning |
|---|---|
| `--apply` | Write. Without it the run is a dry run. |
| `--dry-run` | Explicit dry run (the default). Contradicts `--apply`. |
| `--strict` | Exit 1 unless every required name is real (not the scaffold's `Aria` / `Your Name`) and no identity placeholder survives on Doctor's surfaces. The Interview hand-off uses it. |
| `--config-root <dir>` | The installed tree to render (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`). |
| `--config <file>` | Read identity from this LIFEOS_CONFIG.toml instead of the one under the config root. |
| `--allow-dev` | Write into a maintainer dev install. Sandbox use only. |

**Required tokens:** `{{LIFEOS_VERSION}}`, `{{PRINCIPAL_NAME}}`, `{{PRINCIPAL_FULL_NAME}}`, `{{DA_NAME}}`, `{{DA_FULL_NAME}}`. The voice ids are optional: they render when `[da.voices.main] fish_reference_id` or `voice_id` (or `secondary`) is set.

**What it walks:** `CLAUDE.md`, `settings.json`, `hooks/`, `skills/`, `agents/`, `commands/`, `workflows/`, `LIFEOS/` (the USER link is followed). It never enters `node_modules`, `.git`, `MEMORY`, the redistribution payload `skills/LifeOS/install/`, or the installer's own `skills/LifeOS/{Tools,Intents}`, and never touches `projects/` transcripts.

**Output:** one JSON report: `ok`, `dryRun`, `strict`, `resolved` (token names, never values), `pending` (scaffold names), `missing`, `scanned`, `modified`, `applied`, `survivors` (placeholders left on Doctor's surfaces; predicted in a dry run), `error`, `next`.

**Exit:** 0 ok · 1 not ok (missing config values; in `--strict`, pending names or survivors) · 2 refused (dev install, from the shared guard) · 64 usage error.

A scaffold name is never rendered, because a rendered token is gone and the real name would have nothing left to fill. A second run over the same tree modifies nothing.

Only the identity and version tokens are checked; other `{{TOKEN}}` forms in the payload (Art templating, Fabric pattern bodies) are legitimate and never flagged.
