# Trim

One always-on context file meaningfully shrunk without dropping a single directive: safest cuts first, and the human approves every judgment call.

## Ideal State

- The target is one file from the always-on set, matched by basename when an arg is given or the largest by `wc -c` when none is, and its resolved absolute path was confirmed before anything was touched.
- The starting state was shown before any edit: the file's `wc -c` byte count, where the weight actually sits (per-section byte counts, not a single total), and the target reduction for this run.
- The `ProposalGC.ts` dry-run result existed before any semantic edit was proposed. Its removals were applied only on approval and followed by a fresh `wc -c`, and a run that GC alone made small enough stopped there.
- Semantic trims (RELOCATE, TIGHTEN, MERGE) reached the human as a ranked list, each with the exact target text and estimated bytes saved, ranked by `bytes_saved × safety` (relocate and tighten above merge). Only the ones the human picked were applied, one at a time.
- Every applied merge or tighten keeps every proper noun, file path, tool/command name, env-var name and imperative verb of the original, and still compels the same behavior. Every relocate exists verbatim in the reference, with a stub pointing to it, before the source text is deleted.
- The trimmed file, plus any reference a relocate wrote, is committed alone to the correct repo (USER_DATA for `LIFEOS/USER/**`, `~/.claude` `main` for system files), with nothing else riding along: no peer's staged work and no memory-loop lines this run did not write.
- The report leads with before→after bytes from a re-run `wc -c`, lists what was removed, merged or relocated, gives the commit SHA, names any candidate the safety gate declined and why, and, when the run fell short of its target, says how much remains and offers to continue.

## Anti-criteria

- Detail from a USER file never lands under `LIFEOS/DOCUMENTATION/`, which ships publicly.

## Output format

The opening state reads `<file> — <bytes>` plus per-section byte counts; an auto-append tail is usually where the weight sits.

Each ranked candidate is one of three moves, in decreasing safety:

- **RELOCATE** (safest): rarely-referenced detail (long mechanism explanations, enumerations, examples) → an on-demand reference doc, leaving a one-line stub + pointer. Nothing is lost; it just stops loading every turn. The destination follows the system/user boundary:
  - USER files (`LIFEOS/USER/**`) relocate to the USER side: OPERATIONAL_PREFERENCES to the same-named section of `LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md`, other USER files to their existing reference file (for example DA_IDENTITY's `REFERENCE/`) or `LIFEOS/USER/DOCUMENTATION/`.
  - System files (system prompt, CLAUDE.md) relocate to `LIFEOS/DOCUMENTATION/…`, concept only, as the ISA hierarchy did → `LIFEOS/DOCUMENTATION/ISA/ISAHierarchy.md`.
- **TIGHTEN**: a verbose multi-sentence rule → one plain-language sentence carrying the same directive. Cut throat-clearing, dated war-story prose, and intensifier-only restatements, never the instruction itself.
- **MERGE**: two or more rules that say overlapping things in different words → one rule that carries every distinct directive from all of them.

The report's lead line has the shape `OPERATIONAL_PREFERENCES 40,456 → 28,043 B (−31%)`.

## Inputs

The always-on set is defined in SKILL.md § Data & Config.

- Arg given (`/trim OPERATIONAL_PREFERENCES`): match it against that set by basename.
- No arg: `wc -c` the whole set and take the largest.

## Safety gates

A trim edits live doctrine, so each picked semantic edit passes these checks before it is written:

- Merge or tighten: run `Coverage.ts` (Tool contract) on the original and the replacement. Exit 1 means a directive would be dropped: abort that edit and keep the original. Then re-read the replacement as the file's reader for weaker behavior, which the tool cannot judge.
- Relocate: run `Coverage.ts --verbatim` on the excerpt and the reference, and check the stub, before deleting from the source.

Deterministic GC skips this gate; it only removes provably-redundant entries. The human may pick individual candidates or "all safe ones".

## Tool contract

```bash
wc -c <resolved-path>
```

```bash
bun LIFEOS/TOOLS/ProposalGC.ts            # dry-run — shows superseded / exact-dup / absorbed
```

If it finds removals, show them, then on approval:

```bash
bun LIFEOS/TOOLS/ProposalGC.ts --apply
```

These are provably-redundant (self-marked `[SUPERSEDED]`, exact duplicates, entries already absorbed into the file body), safe to remove without judgment.

Coverage check for each semantic edit, with the original and replacement text (or the relocated excerpt) written to scratch files first:

```bash
bun skills/Trim/Tools/Coverage.ts <original> <replacement>        # merge, tighten
bun skills/Trim/Tools/Coverage.ts --verbatim <excerpt> <reference> # relocate
```

### Intent-to-Flag Mapping

| Move | Flag | Effect |
|------|------|--------|
| MERGE, TIGHTEN | (none) | Lists every token of the original missing from the replacement; exit 1 when any is |
| RELOCATE | `--verbatim` | Confirms the excerpt sits unchanged in the reference; exit 1 when it does not |

Output is one JSON line; flags and exit codes are in `Tools/Coverage.help.md`.

Commit (OPERATIONAL_PREFERENCES § Repo conventions: the private trees take only `CommitOwn.ts`, and a plain `git commit` there is refused). Name the trimmed file and any reference a relocate wrote, by their `~/.claude` paths:

```bash
git -C "$(dirname <path>)" diff -- <path>   # must show only this run's edits
bun LIFEOS/TOOLS/CommitOwn.ts -m "trim: <file> <oldpct>%→<newpct>% (<what>)" -- <path> [<reference-path>]
```

- `CommitOwn.ts` follows the `LIFEOS/USER` symlink, so USER files (`LIFEOS/USER/**`: OPERATIONAL_PREFERENCES, PROJECTS, PRINCIPAL_IDENTITY, DA_IDENTITY) land in the USER_DATA repo at `~/.config/LIFEOS/USER`, and system files (system prompt, CLAUDE.md, ALGORITHM, skills) land on `~/.claude` `main`. It commits only the named paths and leaves a peer's staged entries in place. Paths in two repos take one call each.
- It commits each named file as it is on disk. When the diff shows lines this run did not write (a memory-loop append that landed after the last read), stop and report rather than commit them.
- Report the `commit` SHA from its JSON line.
