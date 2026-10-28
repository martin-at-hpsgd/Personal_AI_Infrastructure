# Append Intent

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Gotchas · Output format

Canonical writer for the three append-only sections of an ISA, `## Decisions`, `## Learning` and `## Verification`, so the C/R/L shape and the one-line Verification stub never degrade across projects.

## Ideal State

- Each entry is appended to the end of its target section (`## Decisions`, `## Learning` (the C/R/L trail), or `## Verification`) in the exact schema under Output format, every prior entry is preserved, and frontmatter `updated: <ISO-8601>` is set.
- A Decision entry is a timestamped log line, carrying the `refined:` prefix when the decision changes the Ideal State (a structural change to L3) or restructures the ISC set, and the `❌ DEAD END:` form when it records a failed attempt not to retry.
- A Learning entry carries all four Deutsch C/R/L pieces (conjectured, refuted by, learned, criterion now) in the four-line indented form, so every project's trail keeps one shape for cross-project search and tooling.
- A Verification entry is exactly one line keyed on an ISC ID that exists in `## Criteria` or, on a feature-based ISA, in a `## Features` block: the probe type and a one-line provenance stub (commit hash, test name, or probe ref) pointing at proof that lives in git and CI.
- When a Verification entry corresponds to a previously-`[ ]` ISC, that ISC is flipped to `[x]` where it lives (`## Criteria` or its `## Features` block) and frontmatter `progress: M/N` is recomputed.
- A target section that does not exist is created in its canonical position: after `## Features` for Decisions, after Decisions for Learning, and after Learning for Verification, before `## Remaining Work` and `## Articulation Log`, which stays the last section.
- The caller receives the exact text that was appended plus the ISA path, so it can re-emit the entry for confirmation.

## Anti-criteria

- Never creates a `## Changelog` section: the ISA carries no changelog section, and `git log -- <isa-path>` is the authoritative change record.
- Never writes a partial entry: when validation fails, nothing is written and the missing piece is surfaced, because silently writing partial entries defeats the point of Append.
- Never lets free-form prose ("we changed our minds about X") stand in for the four-piece C/R/L structure, and never writes a half-entry such as `conjectured` + `criterion now` without the refutation evidence in between.
- Never retains a paragraph of quoted output in `## Verification`, and never writes a Verification entry for an ISC ID that isn't in `## Criteria` or `## Features`.
- Never writes into a malformed ISA whose canonical section position is ambiguous: abort and surface the structural problem.

## Inputs

### When to invoke

- Algorithm at any phase when a non-obvious decision is made: `Skill("ISA", "append decision to <isa-path>: <text>")`
- Algorithm at LEARN when understanding evolved: `Skill("ISA", "append learning to <isa-path>: <conjecture> / <refutation> / <learning> / <criterion-now>")`
- Algorithm at EXECUTE/VERIFY when an ISC passes: `Skill("ISA", "append verification to <isa-path>: <ISC-N> <evidence>")`
- User directly when adding an entry by hand.

Every Decisions, C/R/L and Verification entry passes through Append, except the `bunker pass` Verification stubs `IsaFold.ts` writes from Bunker's pass verdicts.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Safety gates

| Type | Required pieces | Refuse if... |
|------|-----------------|--------------|
| Decision | text + timestamp | text is empty |
| Learning | conjectured + refuted_by + learned + criterion_now + date | any of the four C/R/L pieces is missing |
| Verification | isc_id + probe_type + provenance | isc_id doesn't exist in `## Criteria` or `## Features`, provenance is empty, or provenance is a multi-line paragraph instead of a one-line stub |

## Gotchas

- **Concurrent edits:** Append reads the ISA, decides where to insert, then writes. If the file is edited mid-flight, the second write may insert at a stale offset. Treat Append as best-effort under contention; structural edits to ISAs should be serialized.

## Output format

### Decision

**Schema:**

```
- YYYY-MM-DD HH:MM: <decision text>
- YYYY-MM-DD HH:MM: refined: <what was refined and why>
- YYYY-MM-DD HH:MM: ❌ DEAD END: Tried <X> — failed because <Y> (don't retry)
```

**Inputs:** `text` (required), `kind` (optional: `decision` | `refined` | `dead-end`)

### Learning (the Deutsch C/R/L entry)

Structured entry capturing how thinking evolved, written to `## Learning`.

**Schema:**

```
- YYYY-MM-DD | conjectured: <what we believed>
  refuted by: <evidence that broke the belief>
  learned: <what the evidence taught us>
  criterion now: <which ISC was added/changed/dropped as a result>
```

**Inputs:** All four fields required (`conjectured`, `refuted_by`, `learned`, `criterion_now`).

If any of the four pieces is missing, it is not a Learning entry: refuse it as Learning; what the caller has may go in as a Decision entry instead.

### Verification

ISC-keyed provenance stub, written at VERIFY or on criterion close.

**Schema:**

```
- ISC-N: <probe type> — <one-line provenance stub: commit hash | test name | probe ref>
```

**Inputs:** `isc_id` (required, must exist in `## Criteria` or in a `## Features` block), `probe_type` (required), `provenance` (required — a commit hash, test name, or probe ref; refuse a multi-line paragraph and ask for the stub).

Use the schemas above verbatim. Prefer single-line entries over multi-line where the schema permits.
