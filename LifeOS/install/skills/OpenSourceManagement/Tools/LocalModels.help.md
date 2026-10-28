# LocalModels.ts

Newest open-weight models on the Ollama library, diffed against what a local Ollama
host already has, with a VRAM fit estimate per model.

```bash
bun ~/.claude/skills/OpenSourceManagement/Tools/LocalModels.ts            # markdown
bun ~/.claude/skills/OpenSourceManagement/Tools/LocalModels.ts --json     # JSON
bun ~/.claude/skills/OpenSourceManagement/Tools/LocalModels.ts --limit 40
bun ~/.claude/skills/OpenSourceManagement/Tools/LocalModels.ts --host <ssh-alias>
bun ~/.claude/skills/OpenSourceManagement/Tools/LocalModels.ts --local    # this machine
```

## Inputs

- Host: `ssh_host` in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/OpenSourceManagement/Config.md`
  (`## Local Model Host` table). `--host` overrides; `--local` skips ssh.
- Library: `https://ollama.com/library?sort=newest`, scraped from HTML (no public JSON API).
- Host facts: `ollama list`; GPU memory from `nvidia-smi --query-gpu=memory.total` on an NVIDIA
  host, or on a Mac with no NVIDIA card from `sysctl -n hw.memsize` times 0.75 (an estimate of the
  unified memory macOS lets the GPU use); free disk from POSIX `df -Pk ~` (Linux and macOS). Any
  other GPU reports `no GPU info`, every fit reads `unknown`, and nothing is recommended.

## Columns

- **Fit (~GB)**: Q4_K_M estimate at ~0.6 GB per billion params. The largest size tag that
  fits wins (so a 9b/35b/397b family reports the 35b); if none fit, the smallest is shown.
  `single GPU` ≤ 90% of one card · `split across GPUs` ≤ 90% of all cards · else `no (needs offload)`.
  `size unknown` = no size found anywhere (card, model-page tags, or prose).
- **Have**: `yes` = exact library name present · `variant` = a fine-tuned or quantised build with
  the same family name (e.g. `someuser/<name>-q8`) · `no`.
- **Pull**: filled only for models not present that fit. Uses `name:<size>` when the size is a
  real tag; bare `name` when the size came from prose (those models have quant-only tags).

## Size resolution

Library cards often omit size tags. For a sizeless, non-cloud card the tool fetches the model
page and takes `/library/<name>:<N>b` tag links; if the tags are quant-only (`q4_K_M`, `bf16`),
it reads prose like "33B total parameter" or "118B-A8B".

## Gotchas

- ollama.com class names drift, and the served HTML splits tag attributes across lines, so
  the parser collapses all whitespace before matching. Individual fields are best-effort and
  fall back to `""` or `—`; a blank caps/description column is a parser miss, not a missing
  model. Fix the regex. Two cases do hard-fail (exit 1, message on stderr): a library page where
  zero model cards parse (layout change), and an `ollama list` that errors or returns no models
  (host down, ollama missing, or an empty host), because either would otherwise show every library
  model as "Have: no" with a pull line. Parsers are in `LocalModelsLib.ts`.
- MoE models still load all experts, so total params drive the fit, not active params.
- `variant` matching is substring-on-family; `qwen3.5` will not match `qwen3.6`, but a
  local build named after the family will count. Check the table before trusting a `variant`.
