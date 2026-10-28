---
task: "Compile fixture: a tiny page builder"
slug: compile-fixture
isa_format: 3
---

# Compile fixture

## Ideal State

### L3 · One sentence

A page builder that writes one clean page.

## Criteria

- [ ] ISC-1: `out/page.html` exists after the build.
- [ ] ISC-2: The page reads as written for a beginner.
- [ ] ISC-3: The page's design feels calm and premium.
- [ ] ISC-4: The page loads under one second and the copy is friendly.
- [ ] ISC-5: The build test suite passes.

## Anti-criteria

- [ ] ISC-A1: No page contains a raw markdown heading marker.

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| ISC-5 | bun-test | build tests pass | exit 0 | `bun test ./build.test.ts` |
