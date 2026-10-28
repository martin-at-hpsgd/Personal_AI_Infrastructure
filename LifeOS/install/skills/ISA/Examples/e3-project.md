---
task: "Build a CLI tool that extracts arxiv paper metadata into JSONL"
slug: 20260201-100000_arxiv-extractor-cli
project: ArxivExtractor
effort: advanced
effort_source: explicit
phase: execute
progress: 5/14
mode: interactive
started: 2026-02-01T18:00:00Z
updated: 2026-02-12T03:00:00Z
---

<!-- isa-example claims=12 probes=4 era=legacy -->

## Ideal State

### L3 · One sentence

A single bun TypeScript command turns a list of arxiv paper IDs into clean JSONL, one paper per line, fast enough that a hundred IDs come back in under three seconds.

### L2 · Summary

ArxivExtractor is a stateless one-file CLI that gives researchers structured arxiv metadata to grep, in place of abstracts read one at a time in a browser.

- It takes paper IDs as arguments and writes one JSONL row per paper to stdout.
- Each row carries the id, title, authors, abstract, categories, and submitted and updated dates.
- It runs on Bun alone with no npm dependencies and stays inside arxiv's rate limit.
- It does metadata only: no PDFs, no citation graph, no web UI, no cache.

### L1 · Full articulation

Researching across arxiv papers today means reading abstracts in a browser one at a time. The arxiv API exists, but its XML response is awkward enough that nobody uses it casually, so there is no quick way to get the title, authors, abstract, categories, and submission date for fifty paper IDs in a form that can be grepped.

ArxivExtractor is that tool: a single-file bun TypeScript CLI, `bun arxiv.ts <id1> <id2> ... > papers.jsonl`. It queries the arxiv Atom API, parses the response with a hand-rolled XML parser, and writes one JSONL row per paper to stdout with the fields `id`, `title`, `authors`, `abstract`, `categories`, `submitted`, and `updated`. It runs on Bun alone with no npm dependencies, and it keeps to arxiv's limit of one request every three seconds by sending the IDs in batched `id_list` requests.

It does one job. There is no PDF download, no citation graph, no web UI, and no cache; every run is stateless and hits the API. The moment of success is feeding it a hundred IDs and getting clean JSONL back in under three seconds.

## Problem

Researching across arxiv papers means reading abstracts in a browser one at a time. There is no quick "give me the title, authors, abstract, categories, and submission date for these 50 paper IDs as JSONL so I can grep them" tool. The arxiv API exists but its XML response shape is annoying enough that nobody uses it casually.

## Vision

A single bun TypeScript CLI: `bun arxiv.ts <id1> <id2> ... > papers.jsonl`. One paper per line, structured fields, no friction. Euphoric surprise: feeding 100 IDs and getting clean JSONL back in under three seconds.

## Out of Scope

- No PDF download. Metadata only.
- No citation graph traversal. Single-paper lookup, no following references.
- No web UI. CLI exclusively.
- No persistent cache. Stateless; every run hits the API.

## Constraints

- Bun runtime only. No Node dependency.
- Zero npm dependencies — use Bun's built-in `fetch` and a hand-rolled XML parse.
- Must respect arxiv's API rate limit: one request every 3 seconds per their TOS (the ArXiv skill: "3s between calls"), so IDs go out in batched `id_list` requests, never one request per ID.

## Criteria

- [x] ISC-1: `arxiv.ts` is a single file at the project root.
- [x] ISC-2: Zero entries in `package.json` `dependencies` (probe: `jq '.dependencies | length' package.json` returns 0).
- [ ] ISC-3: `bun arxiv.ts 2401.12345` returns exactly one JSONL row to stdout.
- [ ] ISC-4: The JSONL row has exactly seven fields: `id, title, authors, abstract, categories, submitted, updated`.
- [x] ISC-5: `authors` is an array of strings, never a single concatenated string.
- [ ] ISC-6: `categories` is an array of strings (e.g., `["cs.AI", "cs.LG"]`).
- [ ] ISC-7: A 100-ID batch completes in ≤ 3 seconds wall clock (one batched `id_list` request, so the 3-second spacing rule is never the bottleneck).
- [x] ISC-8: A bad ID (e.g., `9999.99999`) writes a JSONL row with `error` field instead of crashing.
- [ ] ISC-9: stderr stays empty on a successful 100-ID run (no logging clutter).
- [ ] ISC-10: `bun arxiv.ts --help` prints usage in ≤ 12 lines.
- [ ] ISC-11: Anti: out of scope — `arxiv.ts --download` is not a recognized flag (returns help + exits 2).
- [x] ISC-12: Anti: regression — never starts two requests against the arxiv API less than 3 seconds apart.

## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|-----|------|-------|-----------|------|------------|
| ISC-3 | bash | stdout has exactly one JSONL row | 1 line | test "$(bun arxiv.ts 2401.12345 \| wc -l)" -eq 1 |  |
| ISC-7 | bash | wall-clock for 100 IDs | ≤ 3000ms | bun -e 'const ids = (await Bun.file("100-ids.txt").text()).split(/\s+/).filter(Boolean); const t = performance.now(); const r = Bun.spawnSync(["bun", "arxiv.ts", ...ids]); process.exit(r.exitCode === 0 && performance.now() - t <= 3000 ? 0 : 1)' |  |
| ISC-8 | bash | bad ID does not exit non-zero | exit 0 + JSONL row with error field | bun arxiv.ts 9999.99999 \| jq -e '.error' |  |
| ISC-12 | manual | minimum gap between request starts | ≥ 3000ms | instrument fetch with timestamps |  |


## Features

```yaml
- name: AtomFetch
  description: Bun fetch + serial queue sending batched id_list requests, each start ≥ 3s after the last
  satisfies: [ISC-7, ISC-12]
  depends_on: []
  parallelizable: false  # core IO layer

- name: AtomParse
  description: Hand-rolled XML → typed object
  satisfies: [ISC-4, ISC-5, ISC-6]
  depends_on: [AtomFetch]
  parallelizable: false

- name: CLIInterface
  description: Argument parsing, --help, error formatting
  satisfies: [ISC-3, ISC-8, ISC-9, ISC-10, ISC-11]
  depends_on: [AtomParse]
  parallelizable: false  # single-file CLI
```

## Decisions

- 2026-02-01 18:00: Hand-rolled XML parse over a library — Bun has no built-in XML, the response shape is bounded, and adding a dep would violate the zero-deps constraint.
- 2026-02-08 22:30: ❌ DEAD END: Tried Promise.all() with 100 single-ID requests — arxiv rate-limited after request 12. Reverted to batched `id_list` requests spaced 3 seconds apart. Don't retry.
