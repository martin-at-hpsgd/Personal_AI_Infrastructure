<!-- isa-example claims=18 probes=6 era=legacy -->
<!-- Fictitious example. "rsync-verify" is a teaching project name; any resemblance to real tools is coincidental. -->

---
task: "Add SHA-256 verification to a backup CLI's --verify mode"
slug: 20260315-094500_backup-sha256-verify
effort: extended
effort_source: explicit
phase: execute
progress: 9/18
mode: interactive
started: 2026-03-15T16:45:00Z
updated: 2026-03-21T22:00:00Z
---

## Ideal State

### L3 · One sentence

A backup that reports success only when the destination bytes provably match the source, without making a clean run more than 1.5 times slower.

## Problem

The `rsync-verify` CLI copies a source directory to a backup destination and reports completion. It does not currently verify that the destination bytes match the source. Bit rot, partial copies, and silent FS corruption have caused three "successful" backups in the last quarter to land unrestorable. Operators want a `--verify` mode that hashes both sides and surfaces mismatches before the run reports success.

## Criteria

### Verification correctness

- [ ] ISC-1: `rsync-verify --verify <src> <dst>` exits 0 when every file in `<src>` has a SHA-256 match in `<dst>` (probe: integration test against a synthetic 100-file tree).
- [ ] ISC-2: `rsync-verify --verify <src> <dst>` exits 2 when ≥1 file mismatches (probe: integration test that flips 1 byte in `<dst>` then runs verify).
- [ ] ISC-3: The mismatch report lists each diverging file path on stderr, one per line, with `MISMATCH: <path>` prefix.
- [ ] ISC-4: A file present in `<src>` but absent in `<dst>` is reported as `MISSING: <path>` and contributes to the exit-2 count.
- [ ] ISC-5: A file present in `<dst>` but absent in `<src>` is reported as `EXTRA: <path>` and is a warning, not a failure (exit stays 0 if no MISMATCH/MISSING).
- [ ] ISC-6: Hash computation uses a streaming SHA-256 (probe: code review confirms no `Buffer.from(file)` for files > 64KB).

### Performance

- [ ] ISC-7: Verify-mode wall-clock on a 10GB tree is ≤ 1.5× the no-verify wall-clock (probe: `time` benchmark with 10GB synthetic tree).
- [ ] ISC-8: Hashing parallelism is bounded by `os.cpus().length` workers (probe: instrument worker pool counter, assert ≤ CPU count).
- [ ] ISC-9: Memory usage stays under 256MB for any single-file hash regardless of file size (probe: `ps -o rss` sampled during hash of 50GB file).

### CLI surface

- [ ] ISC-10: `rsync-verify --help` lists `--verify` with a one-sentence description.
- [ ] ISC-11: `rsync-verify --verify --json <src> <dst>` emits JSON to stdout with shape `{passed: bool, mismatches: [], missing: [], extra: [], elapsed_ms: number}`.
- [ ] ISC-12: `rsync-verify --verify-only <src> <dst>` skips the copy step and only verifies (probe: timing comparison shows no rsync invocation).

### Error handling

- [ ] ISC-13: Permission-denied on a source file emits `ERROR: cannot read <path>` to stderr and exits 3 (distinct from mismatch exit 2).
- [ ] ISC-14: Interrupting verify with SIGINT prints `verify aborted at file <N>/<total>` and exits 130.

### Anti-criteria

- [ ] ISC-15: Anti: out of scope — `rsync-verify --verify --remote ssh://host/path` does not work (this CLI is local-only; the SSH path is rejected with `ERROR: --verify requires local destination`).
- [ ] ISC-16: Anti: regression — `rsync-verify` (no flag) does NOT silently start verifying. Verify is opt-in only (probe: timing benchmark of plain run is unchanged from pre-feature baseline).
- [ ] ISC-17: Anti: privacy — verify mode never logs file contents to stdout, stderr, or any log file (only paths and hashes).
- [ ] ISC-18: Anti: regression — exit code 0 is reserved for "all files match"; any partial pass (e.g., `--verify --best-effort` if such flag exists later) must use a different exit code so existing scripts don't false-positive.

## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|-----|------|-------|-----------|------|------------|
| ISC-1 | bash | clean backup verifies pass | exit 0 | ./test/integration/clean-tree.sh && rsync-verify --verify ./tmp/src ./tmp/dst |  |
| ISC-2 | bash | corrupted backup fails verify | exit 2 | ./test/integration/clean-tree.sh && printf '\x00' >> ./tmp/dst/file7.bin && { rsync-verify --verify ./tmp/src ./tmp/dst; test $? -eq 2; } |  |
| ISC-7 | bash | verify-mode ≤ 1.5× no-verify | ratio ≤ 1.5 | bash benchmarks/10gb-tree.sh |  |
| ISC-9 | bash | peak RSS during 50GB hash | ≤ 256MB | bash benchmarks/large-file-rss.sh |  |
| ISC-15 | bash | --remote rejected with clear error | stderr contains "ERROR" + exit 1 | err=$(rsync-verify --verify ssh://host/path ./dst 2>&1 >/dev/null); test $? -eq 1 && printf '%s' "$err" \| grep -q "ERROR" |  |
| ISC-17 | bash | file contents never appear in any log stream | 0 occurrences of test fixture content marker | ! rsync-verify --verify ./tmp/src ./tmp/dst 2>&1 \| rg -q "TEST_FIXTURE_SENTINEL_BYTES" |  |


<!--
E2 medium ISA. Required sections: Ideal State (L3 alone), Problem, Criteria, Test Strategy.
Vision, Out of Scope, Principles, Constraints, Features, Decisions, Changelog, Verification omitted — the work surface is single-domain (one CLI, one feature) and the tier completeness gate doesn't require them. ISC count of 18 meets the E2 floor of 16. Four anti-criteria (ISC-15, 16, 17, 18) cover scope, regression, privacy, and a future-compat lock — typical E2 anti-criteria density.
-->
