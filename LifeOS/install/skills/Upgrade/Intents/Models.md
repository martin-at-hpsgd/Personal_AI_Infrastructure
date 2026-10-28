# Models

Move every model LifeOS uses to its vendor's latest same-class release, across every vendor, and leave no model id anywhere in the harness that the registry doesn't control.

## Ideal State

- The report covers every entry in `bun ~/.claude/LIFEOS/ROUTER/Router.ts models`, each checked against its vendor's current lineup in this run, and names what moved, what is current, and what needs the principal's call.
- A model the principal asks to add exists as a `models.ts` lane, an agent named for it, and a Router lane, and `bun ~/.claude/LIFEOS/ROUTER/Router.ts status` passes with it in place.
- `bun ~/.claude/LIFEOS/TOOLS/UpdateModels.ts --check` exits 0. What that proves: no Claude id is pinned anywhere in the tree (a pin equal to the registry is still reported), agent frontmatter uses tier aliases, and no non-Claude versioned id that differs from every `CROSS_VENDOR` value sits in executable code (`.ts/.tsx/.mjs/.js/.py`). It does not see non-Claude ids in Markdown or YAML, nor a code copy of an id that equals a current `CROSS_VENDOR` value; grep for those by hand (`rg -n "gpt-|gemini-|grok-" -g "*.yaml" -g "*.yml"`) before calling the harness clean.
- `bun ~/.claude/LIFEOS/ROUTER/Router.ts status` and `bun ~/.claude/LIFEOS/TOOLS/ModelSync.ts --check` pass.
- Any registry change is committed in `~/.claude` with the explicit paths.

## Anti-criteria

- A family change (flash→pro, turbo→v3, whisper→a different transcription family), a GA→preview move, or a capability change a consumer depends on (voice-model speed support, image-model input shape) is never an automatic write; it is a proposal with the exact one-line `models.ts` edit.
- No researched-vendor candidate (the `🔎` lanes) is written before a live probe with our key succeeds.
- A hardcoded id is never fixed by editing its version; it is fixed at the consumer by adding or reusing a lane in `models.ts` and importing it.
- Nothing outside `LIFEOS/TOOLS/models.ts` holds a model id, and a consumer never types one, outside the historical records excluded in § Drift found by --check (ISAs, Algorithm snapshots, changelogs, `MEMORY/`, tests, eval pins).

## Inputs

`LIFEOS/TOOLS/models.ts` is the list: `CURRENT` holds the Claude tiers, `CROSS_VENDOR` holds every other model as a named lane (OpenAI, Google, xAI, Fish Audio, Perplexity, Replicate, Suno, Cloudflare). `Router.ts models --files` prints each one with its vendor, current id, upgrade path, and every file that uses it. Nothing else holds a model id. A consumer reads a lane (`CROSS_VENDOR.<lane>`, `CURRENT.<tier>`, `--lane <lane>`, an agent's `lane:` or `model:` alias); it never types an id.

## Tool contract

```bash
bun ~/.claude/LIFEOS/TOOLS/ModelSync.ts --sync                       # Anthropic: bump CURRENT from the public models page
bun ~/.claude/LIFEOS/TOOLS/UpdateModels.ts --cross-vendor --sync     # OpenAI, Google, xAI: live roster, same-class bump after a live probe
bun ~/.claude/LIFEOS/TOOLS/UpdateModels.ts --check                   # consumer drift gate (0 clean, 1 drift, 2 the rg scan itself failed)
bun ~/.claude/LIFEOS/ROUTER/Router.ts models --files                 # the list + where each model is used
```

- **Researched vendors.** Lanes the cross-vendor probe prints as `🔎` (Fish Audio, Perplexity, Replicate slugs, a music-generation vendor) have no model-listing API to compare against. Find their current lineup from the vendor's own docs or changelog (`Skill("Research")` quick depth, or WebFetch of the vendor's models page), and live-probe a candidate with our key before writing it.
- **Same class moves, cross class asks (principal directive, 2026-09-03):** the rule is `SKILL.md` § Sources & Tools, "Model moves"; it applies to the researched vendors too, after their live probe.
- **Codex lanes.** `sol`, `astra`, `codexResearcher`, `codexResearcherFast` and `computerUse` run through `codex exec` on the ChatGPT account, which refuses some API-listed ids. `UpdateModels.ts --cross-vendor --sync` (and so the daily `ModelSync.ts --daily`) writes a same-class bump on these lanes only after the API probe AND a `codex exec --model <id>` probe both pass (`CODEX_LANES`, `probeCodex`); a missing or logged-out codex holds the lane and reports it as a finding.

### Drift found by --check

The fix per the Anti-criteria: add or reuse a lane in `models.ts`, import it (`import { CROSS_VENDOR } from "<relative>/LIFEOS/TOOLS/models"`), and re-run `--check`. Historical records (ISAs, Algorithm snapshots, changelogs, `MEMORY/`, tests, eval pins) are excluded on purpose; they record what ran.

## Output format

Lead with what moved (`lane: old → new`, probe result), then open decisions (cross-class candidates, probe failures, missing lanes), then the `Router.ts models` summary line as proof every vendor was checked. The daily job (`com.lifeos.modelsync`, `ModelSync.ts --daily`) runs the deterministic half every day; this intent adds the researched vendors and the decisions.
