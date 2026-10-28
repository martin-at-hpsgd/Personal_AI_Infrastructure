---
task: "Split fixture: every parent shape compile split must handle"
slug: split-fixture
---

# Split fixture

## Criteria

- [x] ISC-1: The export writes a file and prints its path.
- ISC-2: The CLI accepts --json and its exit code is 0 on success.
  The flag is documented in the help text.
- [ ] ISC-3: [container] The report renders.
  - [ ] ISC-3.1: The report has a title.
  - [ ] ISC-3.2: The report has a footer.
- [ ] ISC-4: [container] A container with no children yet.
- [ ] C5: Anti: no secret appears in the log or the export.

## Anti-criteria

- [ ] ISC-A1: No temp file survives and no lock file survives.

## Features

| id | feature |
|---|---|
| F1 | export + import |

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| ISC-3.1 | bash | title | exit 0 | `rg -q title ./out.html` |

## Decisions

- ISC-1 was split on purpose later.

## Articulation Log

- 2026-10-01: scaffolded.
