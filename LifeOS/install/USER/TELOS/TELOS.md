---
provenance: template
last_updated: 2026-01-01T00:00:00Z
last_updated_by: bootstrap-template
convention: lifeos-freshness-v1
---

# TELOS — Your Name

> 🎯 SAMPLE TEMPLATE — this is the single source of truth for your TELOS (your mission, goals, problems, and the rest). Every entry below is a placeholder showing the SHAPE of the data. Run `/interview` (or just talk to your DA) to replace these samples with your real life context. Pulse reads this file to render your rings, freshness, and TELOS overview — it comes alive once you fill it in.

## Current State (where you are now)

- Health: (sample) TBD — describe your current health, energy, sleep.
- Finances: (sample) TBD — describe your current financial state.
- Relationships: (sample) TBD — describe your current relationships.

## Ideal State (where you want to be)

- Health: (sample) TBD — the health you're aiming for.
- Finances: (sample) TBD — the financial state you're aiming for.
- Creative: (sample) TBD — the creative life you're aiming for.

## Mission

- **M0:** (sample) The one-sentence reason you do what you do.

## Problems (the problems in the world you're trying to solve)

- **P0:** (sample) A problem you care about solving.
- **P1:** (sample) A second problem worth your time.

## GOALS (measurable milestones toward the problems)

- **G0:** (sample) Ship X by date Y — measurable: <criterion>.
- **G1:** (sample) Reach <number> of <thing> this year.

## Challenges (things stopping you from hitting your goals)

- **C0:** (sample) A recurring obstacle you face.
- **C1:** (sample) A second challenge to work on.

## Risks (RN) (the top scenarios that could take you off the path to your ideal state, each with the current state of prevent, detect, and respond)

Scored likelihood × impact on a 1–5 scale (Low 1–4 · Medium 5–9 · High 10–14 · Critical 15–25), the same scale the ThreatModel estate register uses. Each prevent / detect / respond line opens with its state: `none`, `partial`, `have`, or `unknown`. Links point at the row, question, finding, runbook, or document that carries the detail; `bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts validate --links` checks every one resolves. Cover every domain of your life (money, health, continuity, business, physical, security) — not only the technical ones. Doc: `LIFEOS/DOCUMENTATION/Telos/RiskRegister.md`.

### R0: (sample) A prompt injection borrows your DA's authority
- domain: security · likelihood: 3 · impact: 5 · owner: your-da · review_by: 2027-01-01
- scenario: (sample) Text you never wrote reaches a session that can publish, deploy, and spend, and it acts on it.
- prevent: partial — (sample) the constitution and the safety hook flag it; nothing blocks.
- detect: partial — (sample) the injection-shape flag on every external read; a daily standing question.
- respond: none — (sample) no agent-incident runbook yet.
- links: doc:LIFEOS/DOCUMENTATION/Telos/RiskRegister.md

### R1: (sample) Cash runs too thin for a tax bill and an income dip
- domain: finance · likelihood: 2 · impact: 4 · owner: you · review_by: 2027-01-01
- scenario: (sample) One soft quarter plus a scheduled payment forces a sale at the wrong time.
- prevent: none — (sample) no cash floor written down.
- detect: partial — (sample) a monthly burn question ticks; no live balance.
- respond: none — (sample) no liquidity playbook.
- links: doc:LIFEOS/USER/FINANCES/FINANCES.md

## Strategies (how you'll overcome the challenges)

- **S0:** (sample) A concrete strategy you're committing to.

## Projects (what you're working on to pursue the strategies)

- **PR0:** (sample) A current project, with its status.

## Narratives (talking points for talks, panels, posts)

- **N0:** (sample) A story or claim you want to be known for.

## Wisdom (favorite lessons and aphorisms)

- (sample) A lesson you've learned that guides you.

---
*This file is the canonical TELOS. The DA and Pulse read it directly; fill it in with the interview.*
