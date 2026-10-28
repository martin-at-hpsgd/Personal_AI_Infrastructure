---
last_updated: 2026-10-21T00:00:00Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.0.8
---

# Vera — Versioned Ideal-State Profiles of People

> From *verus*, truth. Vera holds a living, evidence-backed profile for each person in scope (public figures, and people who agreed to be profiled; see § Who may be profiled). The profile is the artifact, and every score is a projection queried from it, including a 1-100 VERA composite. Design of record: `LIFEOS/VERA/ISA.md` (maintainer-side; the ISA does not ship).

## Who may be profiled

Profiles are for two groups only: public figures, judged on their public work, and people who agreed to be profiled. Do not create, import or enrich a profile of anyone else, such as a private person in your contacts, a colleague, a candidate or a family member who has not said yes.

This is a rule for whoever runs Vera, not a mechanical check. `import-kb` reads every Cortex People note, and `add`, `ingest` and `Enrich.ts` accept any slug, so you choose who enters the roster. Keep People notes for out-of-scope people out of the import, and delete `people/<slug>/` for anyone outside scope or who withdraws consent.

## The idea

Every source judgment ("who is this and how much should I weight them") deserves evidence discipline, not vibes. Vera keeps a typed claim ledger per person; scores at any level are computed projections over rows, never stored. Rate claims, not people: the person's rating falls out of the ledger, forgiveness is time decay, and trajectory is signal.

## Architecture

| Piece | Home | Role |
|---|---|---|
| Claim ledgers | `LIFEOS/USER/VERA/people/<slug>/claims.jsonl` | Restricted Data, git-versioned (git IS the version layer; a profile's history is `git log`) |
| Schema + store | `LIFEOS/VERA/Schema.ts`, `Store.ts` | Typed rows, invariant-gated writes, credential-shape refusal |
| Scoring | `LIFEOS/VERA/Scoring.ts` | Leaf scores, composites, decay, display calibration — all computed at read time |
| Profile view | `LIFEOS/VERA/Profile.ts` → `Profile.md` | Deterministic regeneration; analysis section; personal rows never render |
| Analysis | `LIFEOS/VERA/Assess.ts` → `analysis.json` | One honest model-written paragraph + bullets per profile; explains the ledger, never scores it |
| Corpus engine | `LIFEOS/VERA/Enrich.ts` | Document corpus → claim rows via one model pass per doc; checkpointed by content hash, idempotent |
| Output record | `LIFEOS/VERA/Output.ts` → `people/<slug>/output.jsonl`, `channels.json` | Everything a person has published, one row per URL with its date source; counts, timelines and before/after rates computed over distinct works (cross-posts merged); rendered as the profile's Output section. Written by the optional receipts skill, if installed |
| CLI | `bun LIFEOS/VERA/Vera.ts` | init · add · resolve · score · ask · profile · import-kb · ingest · export-pulse · list · stale (people whose analysis is missing or older than their ledger; exits 1 when any) |
| Pulse board | `/vera` (module `LIFEOS/PULSE/modules/vera.ts`) | Reads only the redacted snapshot; card score + full decomposition behind the click |

## The claim row

Every row carries: statement, source, source_kind, happened (event date), recorded, axes[], kind, confidence, sensitivity — plus optional value, resolution, resolved, stated_p. Kinds are disjoint:

- **verifiable** — predictions/actions with checkable outcomes; resolve to true/false; only resolved rows feed accuracy leaves (Brier-style when a stated probability exists).
- **judged** — model assessments of demonstrated craft; `value` is the assessed quality, `confidence` is how strongly the evidence supports it. Judged rows never enter an accuracy leaf.
- **biographical** — context facts; a modest default value, confidence as weight.

`sensitivity: personal` excludes a row from every scoring path and every rendered or exported surface — the evidence store keeps everything, the scoring layer reads only what the queried axis justifies.

## Scoring principles (all invariant-tested)

- **Absence widens, never subtracts.** Zero evidence → "insufficient signal", not zero. Thin-but-strong evidence reads high-estimate/wide-interval.
- **Decay is forgiveness.** Rows fade with age (configurable half-life) — but a resolved-TRUE prediction ages from its resolution date, and long-horizon resolved calls carry up to 3x weight. Being right early is the most valuable signal, not the stalest.
- **Confidence is a weight, never the value.**
- **The axes tree is view config** (default 4 branches × 4 leaves: judgment, craft, conduct, position) over free tags — changing it needs no ledger migration.
- **Composites are computed, never stored**, and decompose fully: card score → branch scores → leaf bars → the exact rows (`ask --explain`).
- **Display calibration:** raw evidence math compresses humans into ~0.45-0.75; a tanh expansion spreads the band so 50 = neutral/unknown and 100 = a perfect-ASI asymptote reachable only at raw 1.0.

## Privacy

Profiles are private to the owner's Cortex. Nothing publishes externally; personal-life rows never affect any score and never leave the store; the Pulse module serves a redacted snapshot only.

Scope: Vera weighs people by their public work. Evidence comes only from what a person published or did in public, attributable to them by name; covert collection, private records and personal-life detail are out of scope. "Every row must survive being shown to the person it is about" is a review standard written into the enrichment and analysis prompts (`Enrich.ts`, `Assess.ts`), not a deterministic check: the only mechanical exclusion is `sensitivity: personal`.

## Boundaries

- Person identity = Cortex kb-v3 People slugs — one namespace, no parallel registry.
- Vera's inputs stay disjoint from the content judgments, so agreement between the two carries information.
- Out of scope: public scorecards, third-party rating services, personality-model inference from text.
