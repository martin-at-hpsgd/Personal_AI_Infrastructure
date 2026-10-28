---
name: ThreatModel
evals:
  manual:
    reason: "a threat model must be reviewed against the actual estate's data flows, trust boundaries, and compromise scenarios"
    falsifier: "the reviewer finds a material asset, boundary, scenario, or risk treatment missing or misclassified"
metadata:
  short-description: "Map sensitive data and agent trust boundaries, model compromise scenarios, and maintain estate risks. Excludes active pentests and incident execution."
version: 1.3.2
description: Defensive threat modeling of your own estate: sensitive-data map, trust boundaries, compromise scenarios, a scored risk register via CLI. USE WHEN run a full security audit, security audit, how exposed am I, threat model, risk register, risk assessment, what if X got hacked, compromise scenario, blast radius, sensitive data map, data classification, add a risk, accept a risk, injection surfaces, trust boundaries, lethal trifecta. NOT FOR pentesting (a private-only offensive skill), futures or stress-testing an idea (RedTeam, Research), running IR.
---

# ThreatModel

**Contents:** Ideal State · Intent Routing · Data & Config (safety gate) · Risk Scoring · Asset Graph Integration · Continuous review and the TELOS link · Gotchas · Examples

Threat modeling for the estate you actually run. Three moves: classify where sensitive data lives, simulate compromise of the assets that hold it, and keep the resulting risks in a register that gets reviewed instead of forgotten.

## Ideal State

- Every artifact a run produces (data map, scenario, injection map, target model, register entry) sits in the private data dir with no secret value in it, and the skill tree holds code only.
- Impact and likelihood rest on evidence: data classes and what an asset can reach for impact, exposure for likelihood, Atlas output where the install has it and a stated hand-built inventory where it does not.
- Every real risk a run surfaces lands in the register through the CLI with a score, a scope and a review date, so the Socrates review loop (`References/Continuous.md`) reviews it instead of it being forgotten.
- The estate is modeled, never touched: no run exploits, scans or changes an asset, and the audit writes none of the registers it reads.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **SensitiveDataMap** | "where is our sensitive data", "data classification", "which assets hold sensitive data" | `Intents/SensitiveDataMap.md` |
| **CompromiseScenario** | "what if X got hacked", "compromise scenario", "blast radius of X" | `Intents/CompromiseScenario.md` |
| **ThreatModelTarget** | "threat model X", "threat model the estate", "risk assessment of X" | `Intents/ThreatModelTarget.md` |
| **InjectionSurfaceMap** | "prompt injection", "injection surfaces", "where can untrusted content get in", "trust boundaries", "what can inject into the agent", "lethal trifecta" | `Intents/InjectionSurfaceMap.md` |
| **RiskRegister** | "risk register", "add a risk", "risk review", "accept risk", "close risk" | `Intents/RiskRegister.md` |
| **SecurityAudit** | "run a full security audit", "security audit", "how exposed am I", "audit our security", "latest audit" | `Intents/SecurityAudit.md` |

| File | Read when |
|------|-----------|
| `References/Continuous.md` | Setting `--telos-ref` or `scope` on a row, exporting one scope, or changing what the daily Socrates questions check |

## Data & Config (safety gate)

This skill directory is public code, so it never holds data.

- Data dir: `~/.claude/LIFEOS/USER/SECURITY/THREATMODEL/` by default (release-excluded USER tree); `THREATMODEL_DATA_DIR` overrides it. `Tools/RiskRegister.ts` structurally refuses any data dir that resolves inside a `skills/` path.
- Register entries reference credentials by env-var name only, never by value. No tokens, keys, or cookies anywhere in threat-model output.
- Customizations: `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ThreatModel/PREFERENCES.md`, where configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. When it exists, load and apply it before executing (data locations, sensitive-data class priorities, response runbook cross-references); otherwise use the defaults.

## Risk Scoring

`score = likelihood (1-5) × impact (1-5)` → **Low** 1-4 · **Medium** 5-9 · **High** 10-14 · **Critical** 15-25. The CLI computes score and level from the two inputs.

Impact is anchored to data classes and blast radius: an asset whose compromise exposes credentials or customer data starts at impact 4+. A worker with no data of its own routinely inherits a 5 through its bindings.

- 5: credentials to many systems, customer data at scale, or financial/health PII
- 4: credentials to one data-bearing system, or a private data store
- 3: internal-only data, or write access to a public surface
- 2: limited internal exposure
- 1: public-only data, no pivot

Likelihood is anchored to exposure (public URL, auth boundary, patch state, credential hygiene).

## Asset Graph Integration

If the install has Atlas (`~/.claude/LIFEOS/ATLAS/Atlas.ts`), intents use it as the current-state source of truth:

```bash
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts blast <key>     # what relies on this asset
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts owns <key>      # what deleting/losing it orphans
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts exposed <key>   # which credentials it would leak, priority-ordered
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts injection       # ingestion surfaces by trust class + control coverage
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts reach <key>     # what an injection at a surface could ultimately drive
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts sql "SELECT ..."  # read-only census queries
```

`exposed` makes the "one hop of trust" step deterministic instead of a judgment call: it returns the credentials an asset holds, transitively through what it owns, compromise-tier first. Pair it with a DEPENDS_ON query for the data stores an asset can reach:

```bash
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts sql "SELECT a.kind, a.canonical_key FROM edge e JOIN asset a ON a.id=e.dst WHERE e.kind='DEPENDS_ON' AND e.status='active' AND e.src=(SELECT id FROM asset WHERE canonical_key='<key>')"
```

Without Atlas, intents fall back to what the user enumerates plus repo/config inspection, and say so in the output. Never invent an inventory.

## Continuous review and the TELOS link

The register is watched daily by Socrates questions, and every row points up to a TELOS life risk with `--telos-ref Rn` and carries a `scope`. The questions, the two tiers and the scope export: `References/Continuous.md`.

## Gotchas

- **Unclassified ≠ safe.** An asset with no sensitive-data tag is *unclassified*, never *clean*. Absence of classification is not evidence of absence of data (the absence-metric rule). SensitiveDataMap output must list unclassified assets explicitly.
- **Graph blast radius is derived evidence.** Asset-graph queries show what the graph knows; before treating a blast radius as complete for a high-stakes decision, confirm against the provider's authority API (the graph can lag or under-model edges).
- **An ingestion surface is an asset.** A place where somebody else's text reaches the agent belongs in the model next to the servers, because the agent holds the principal's authority and injected text borrows it. Threat modeling that covers only infrastructure misses the surface class that needs no credential at all.
- **For injection, score the capability, not the surface.** A stranger's comment is worthless text; the risk is the session reading it while holding publish, deploy, and repo-write. Rank by what the deputy can do, and by whether anything blocks rather than merely watches.
- **Persistent beats loud.** A poisoned page ruins a turn. A poisoned memory entry, archive note, ledger row, or log line re-enters context on every later recall with its provenance gone. Untrusted plus persistent plus nothing blocking is the top of every injection list.
- **A concrete, actionable weakness surfaced by a review also registers in Achilles** (`bun ~/.claude/LIFEOS/TOOLS/Achilles.ts add --source threatmodel --risk-ref R-xxx ...`) — the register keeps the standing risk, Achilles tracks the instance to closure with evidence. Achilles validates `risk_ref` against this register at write time. Doctrine: `LIFEOS/DOCUMENTATION/Achilles/AchillesSystem.md`.

## Examples

**Example 1: Sensitive data sweep**
```
User: "Which of our assets have sensitive data?"
→ SensitiveDataMap: census the asset graph, classify each data-bearing asset
→ Writes EstateDataMap.md to the private data dir
→ Returns the classified map + explicit unclassified list
```

**Example 2: Compromise scenario**
```
User: "What happens if our analytics worker gets popped?"
→ CompromiseScenario: blast radius via asset graph, data exposed, attacker next-steps,
  detection signals, response plan
→ Scenario doc to private data dir; risks added to register with scores
```

**Example 3: Risk review**
```
User: "Run a risk review"
→ RiskRegister: lists overdue + open risks by score, walks disposition
  (mitigate / accept / close), updates review dates
```
