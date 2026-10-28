---
version: 1.0.3
last_updated: 2026-09-10
convention: lifeos-freshness-v1
---

# The TELOS Risk Register (`## Risks (RN)`)

> The ten scenarios most likely to take you off the path to your ideal state, across every domain of your life, each carrying the current state of **prevent**, **detect**, and **respond** and links into the systems that already watch it. It lives in your TELOS because a risk is a claim about the gap between current and ideal state, and the whole system exists to close that gap.

## Why it lives in TELOS

LifeOS already had risk machinery: the ThreatModel skill's estate register (`R-NNN` rows scored likelihood × impact), Socrates standing questions that fail loudly, Achilles for every known weakness, incident runbooks, incident records. All of it was technical. Nothing said "the emergency fund covers one month", "a single provider outage takes every site down", "nobody else can reach the accounts", or "an injury stops the work for a season". Those are the risks that decide whether the ideal state is reachable at all, and they belong next to the goals they threaten.

So the register is a TELOS section, not another tool. Its ids follow the TELOS convention (`R0`, `R1`, … zero-indexed, never renumbered), it is reviewed on the same freshness clock as Goals and Strategies, and everything technical underneath points up at it by id.

## The entry shape

```markdown
## Risks (RN) (the top scenarios that could take you off the path to your ideal state, each with the current state of prevent, detect, and respond)

### R0: A prompt injection borrows the DA's authority
- domain: security · likelihood: 3 · impact: 5 · owner: assistant · review_by: 2026-01-01
- scenario: Text you never wrote reaches a session that can publish, deploy, and spend, and it acts on it.
- prevent: partial — the constitution and the safety hook flag it; write-time gates close the persistent surfaces; nothing blocks on read.
- detect: partial — injection-shape flag on every external read; a daily standing question.
- respond: none — no agent-incident runbook yet.
- links: R-001, SOC-0001, ACH-0001, T1.1, doc:LIFEOS/DOCUMENTATION/Security/SecurityModel.md   (example ids)
```

| Field | Meaning |
|---|---|
| `domain` | one word: `security`, `finance`, `health`, `continuity`, `business`, `physical`, or your own |
| `likelihood`, `impact` | integers 1–5; score = product; Low 1–4 · Medium 5–9 · High 10–14 · Critical 15–25 — the same scale as the estate register so the two compare on one number |
| `owner` | who carries it (you, your DA, a named person) |
| `review_by` | `YYYY-MM-DD`; cadence follows level (Critical 30d, High 60d, Medium 90d) |
| `scenario` | the bad day, in one or two sentences, as you would describe it to a friend |
| `prevent` / `detect` / `respond` | opens with `none`, `partial`, `have`, or `unknown` (nobody has checked; never counts as coverage), then the concrete current state: the control, the question, the runbook, or the named absence. `have` is the word that rots fastest; the review date is what keeps it honest |
| `links` | comma-separated tokens: `R-NNN` (ThreatModel estate register), `SOC-NNNN` (Socrates), `ACH-NNNN` (Achilles), `INC-YYYYMMDD-slug` (incident record), `Tn` / `Tn.m` (SecurityPosture threat id), a TELOS id (`G3`, `C7`), `runbook:<path>`, `doc:<path>` |

Ten is the number because a register anyone will actually re-read is short. Everything below the cut goes in one "watched but not in the ten" sentence under the entries, so the cut is visible.

## The machinery

One parser reads the section; every consumer uses it.

```bash
bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts list [--json]        # every risk with its P/D/R states
bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts show R3 [--json]     # one risk in full
bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts validate [--links]   # shape check; --links resolves every token (exit 1 on any error)
bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts summary              # one line per risk, for the TELOS summary
```

| Consumer | What it does |
|---|---|
| `GenerateTelosSummary.ts` | renders a `## Top Risks` block into `PRINCIPAL_TELOS.md`, so every session starts knowing the ten and their P/D/R states |
| `TelosFreshness.ts` | scores the section on a 30-day threshold; the Interview skill walks stale risks per entry like any typed-ID section |
| Socrates `telos-risks` adapter | three daily questions: `overdue-review` (a risk past its review date), `unwatched` (detect `none` or `unknown` and no link to an ACTIVE standing question — an unanswerable question is a wish and an Achilles link is a weakness; neither counts as watching), `broken-links` (the section fails to parse or a link no longer resolves). Persisting failures route to Achilles like any other question |
| Pulse | `GET /api/telos/risks` — the parsed register, for a card or the DA panel |
| ThreatModel `RiskRegister.ts` | an estate row carries `--telos-ref Rn`, validated against the section; every open High or Critical row should have one, so a failure there reads as "Rn detect went red" |
| Incident runbooks (an install-local skill, where one exists) | every runbook is the respond leg of some `Rn`; open an incident by naming the risk |
| Achilles | keeps pointing at `R-NNN`; the chain is ACH → R-NNN → Rn |
| SecurityPosture (private) | a closing section maps its threat ids to the `Rn` they roll up to |

The two id shapes never collide: `R7` is a life risk, `R-007` is an estate row.

## Writing the ten

Look at everything, not the infrastructure: the finances files (concentration, cash, leverage, tax), the health files, the ideal state (what would end it), the business (which platform or account is the reset root for everything), the house, and only then the estate register and posture. For each candidate, ask what the current state of prevent, detect, and respond actually is on disk today, and write the state word honestly — `none` is the most useful word in the register. Rank by score, keep ten, name the cut. Then run `validate --links` until it is clean, and let the daily questions keep it that way.

## Rules

- The section is the system of record; the parser never writes it. Edit TELOS, then validate.
- Ids are stable. A dropped risk leaves a `[DROPPED — see …]` tombstone; a split becomes `R3.1` in prose with a new `R10` entry.
- No secret values, ever. Credentials appear by name only, if at all.
- A `respond: none` line is a finding, not a failure of the register: it is the register doing its job.
