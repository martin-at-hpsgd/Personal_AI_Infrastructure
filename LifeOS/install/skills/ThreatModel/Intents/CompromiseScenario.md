# CompromiseScenario

Answer "what happens if asset X gets hacked" with real blast-radius data, and land the resulting risks in the register.

## Ideal State

- A scenario doc `Scenarios/<asset-slug>.md` exists in the data dir with every part the Output format names, complete enough that a responder could act on it.
- The impact score rests on both the `atlas exposed` output and the DEPENDS_ON data-store query (or, without Atlas, the config and bindings inspection), and the asset & trust part cites them.
- Impact is anchored to what the compromise exposes plus what it reaches, not to the asset's size, using the anchors in SKILL.md § Risk Scoring; likelihood is anchored to exposure (public URL, auth boundary strength, patch/credential hygiene, existing detection).
- When `exposed` returns more than one compromise-tier class on a single asset, that concentration is written up as a distinct risk rather than folded into the asset's main scenario score.
- The scenario names what the graph cannot see (vendor-only OAuth grants, SSH keys, browser sessions, password managers) as part of the scenario, and for a high-stakes scenario the critical edges were confirmed against the provider's authority API before the blast radius is treated as complete.
- For an ingestion-surface target, the capability closure comes from `atlas reach`, the score is by the capability borrowed rather than the data stored, and persistence is explicit: where the text lands and what re-reads it later.
- Each real risk the scenario surfaces is in the register through `RiskRegister.ts add`, with scores, `--response` pointing at the scenario doc, and a `--review-by` date.
- The close summarizes the worst realistic outcome, the top exposed data classes, whether detection exists today, and the risks landed (IDs + scores), and flags any critical risk for immediate attention.

## Anti-criteria

- Never executes an exploit, scan, or destructive action from a threat-model run; offensive testing is a separate offensive-security skill.
- The response part never duplicates the incident-response runbook; it points at it.
- When Atlas is absent, the blast radius is built from config/bindings inspection and the scenario says so; it is never presented as graph-derived.

## Inputs

Need one concrete asset (an Atlas key, an app, a domain, a worker). If none is given and it can't be inferred, ask which asset. Otherwise proceed.

An **ingestion surface** (`ingest:<id>`) is a valid target here too — "what if a poisoned feed item lands", "what if someone opens a hostile issue on the public repo". The compromise walk is the same shape with one substitution: the attacker never gets a credential, they get the agent to act. Full frame: `Intents/InjectionSurfaceMap.md`.

## Output format

A scenario doc `Scenarios/<asset-slug>.md` in the data dir, containing:

1. **Asset & trust** — what it is, what data it holds (from SensitiveDataMap / classification), what it can reach (credentials, service bindings, deploy keys — one hop of trust minimum).
2. **Blast radius** — what depends on it and what it owns, from the asset graph, treated as derived evidence.
3. **Compromise walk** — plausible entry, what the attacker reads/writes/pivots to, worst realistic outcome.
4. **Exposure** — concrete data classes exposed and roughly how many records/systems.
5. **Detection** — what signal would catch this (logs, scanner, anomaly), and whether that signal exists today.
6. **Response** — containment steps, credential rotation refs (point at the incident-response runbook, don't duplicate it), and recovery.
7. **Residual risk** — what stays exposed even after the planned response.

## Tool contract

Blast radius, ownership, `exposed` and the DEPENDS_ON data-store query are the Atlas commands in SKILL.md § Asset Graph Integration.

For each real risk the scenario surfaces:

```bash
bun ~/.claude/skills/ThreatModel/Tools/RiskRegister.ts add \
  --title "<short risk>" --threat "<threat>" \
  --assets "<atlas-key>" --data-classes "<classes>" \
  --likelihood <1-5> --impact <1-5> \
  --response "Scenarios/<asset-slug>.md" --review-by <YYYY-MM-DD> \
  --mitigation "<control>"
```

## Gotchas

**Credential concentration needs its own mitigation.** Two credential classes reaching two different trust domains from one asset collapse a boundary, so the fix is to split the credentials, not rotate them.
