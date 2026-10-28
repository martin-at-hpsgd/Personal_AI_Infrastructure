---
name: Hardening
evals:
  manual:
    reason: "property-based tests are useful only when their properties and generators match the actual system invariant"
    falsifier: "the reviewer finds a property cannot expose the stated invariant violation or a generated counterexample is not actionable"
metadata:
  short-description: "Strengthen code tests using fast-check property-based testing and shrunk counterexamples. Use Assay for agent quality and Interceptor for UI verification."
version: 1.2.1
description: Hardens LifeOS tests via property-based testing with fast-check. USE WHEN harden, hardening, property test, property based testing, PBT, fast-check, strengthen tests, find bugs example tests miss, universal quantified claim, shrink counterexample, what bugs am I missing, test the tests. NOT FOR new feature tests (bun test directly), grading agent output (Assay), UI verification (Interceptor), finding security vulnerabilities, or building new functionality.
---

# Hardening Skill

Hardening sharpens tests that already exist without adding new functionality: it turns the universal claim behind a set of example tests into a fast-check property, runs it across generated inputs, and shrinks any failure to the minimal counterexample.

One intent ships. Mutation testing, complexity scoring, duplication scanning, and acceptance-test mutation were once listed here as planned; none is built, and this file no longer advertises them (external review of the v7.40.4 payload, 2026-09-03: a routing table that promises unbuilt intents is the "confidently documented, never existed" class).

## Ideal State

- Every property written states the universal claim behind existing example tests, runs across generated inputs drawn from the function's real input domain, and keeps the examples it sharpens.
- Every failure ends shrunk to a minimal counterexample with its seed, and ends in either a fixed bug or a corrected property.
- What hardening lands is recorded where the system reads it: a `bun-property` row in the ISA's Test Strategy, and a C/R/L Learning entry when a counterexample taught something.
- Functions that cannot carry a universal claim (impure, or no candidate shape) are left to example tests rather than forced into a property.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| PropertyTest | property test, property based testing, PBT, fast-check, universal quantified claim, shrink counterexample — pure functions, parsers, serializers, data transforms, invariants | `Intents/PropertyTest.md` |

## Integration Points

- **Testing Doctrine Rule #12** — names fast-check as the property-testing primitive (`LIFEOS/DOCUMENTATION/Testing/TestingDoctrine.md`).
- **ISA format** — the `bun-property` ISC type with `property | generator | runs` columns (`LIFEOS/DOCUMENTATION/ISA/ISAFormat.md` § ISC Type Vocabulary). A `bun-property` row is a first-class assert: it counts toward every-ISC-an-assert coverage (H8) and `bunker test` runs it like any deterministic row.
- **Algorithm** — hardening is elected during verification when a run's criteria warrant property depth; spend is discovered from the work.
- **System prompt** — Verification Is the Mechanism section at top (`LIFEOS/LIFEOS_SYSTEM_PROMPT.md`).
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Gotchas

_No skill-wide gotchas; the fast-check ones live in `Intents/PropertyTest.md` § Gotchas._

## Examples

- "Property-test the slug parser" → PropertyTest → round-trip and idempotence properties in a `.property.test.ts` file at 1000 runs, a `bun-property` row in the ISA, and any failure shrunk with its seed pinned.
- "What bugs are my example tests missing?" → PropertyTest → the pure functions (parsers, serializers, transforms) that have only example coverage, listed as property-test candidates.
