# ThreatModelTarget

Threat model one target — an app, a service, a data flow, or the whole estate — end to end.

## Ideal State

- A threat model for the target is written to the data dir covering: what it is and its trust boundaries (what's inside the target, what it trusts, what trusts it, from asset graph edges), what data crosses those boundaries, who would attack it and why, the realistic threats, existing controls, gaps, and prioritized risks in the register.
- What data the target holds was established through SensitiveDataMap before the model was written, and a CompromiseScenario exists for each of the target's components that hold credentials or are among its highest-sensitivity assets in that map; for a broad target ("the whole estate") the model is a portfolio pass, and the scenarios cover its top data-bearing assets.
- Threats are enumerated against each boundary crossing and each data store, STRIDE per element.
- Each credible threat carries a decision: existing control adequate (noted), needs mitigation, or accept; every one that is not adequate is a register entry with likelihood×impact.
- Risks are ranked by score, and every Critical/High has a named owner and a `review_by`.
- The close reports the target's trust boundaries, the top threats by score, which are covered vs open, and the register IDs created, and points to the scenario docs for the deep dives.

## Anti-criteria

- No exploitation, no scanning, no destructive action.
- Never invents inventory: if the asset graph is absent, the output states that coverage is user-enumerated.

## Inputs

Need the target and its trust boundary; a broad target ("the whole estate") is valid. Ambiguity that changes scope → one flag, then proceed.

## Output format

A threat model in the data dir, in this order: what the target is and its trust boundaries, the data that crosses them, who would attack it and why, the realistic threats (STRIDE per element: spoofing, tampering, repudiation, info-disclosure, DoS, elevation), existing controls, gaps, and the prioritized risks landed in the register with scores.

## Tool contract

- The `Fabric` skill's `create_threat_model` / STRIDE patterns are available if a structured pass helps.
