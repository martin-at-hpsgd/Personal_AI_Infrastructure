# Test — is the ISA sound, does the code match it, does every criterion pass?

Reads an application and its ISA and reports, criterion by criterion.

## Ideal State

- The report has the four parts in Output format, in order: well formed, sync, criteria, the read.
- `IsaCheck.ts write-probes` ran before any criteria row; when it found a production write row, no criteria row ran and the report lists those rows with the local or staging target each should use.
- The sync part names the surface kinds the inventory cannot see, so a clean sync is never read as full coverage.
- Every ISC appears with its result at its Assay tier, and provisional passes (a judgment-layer or judge answer that has not earned the right to decide) are listed apart from real passes.
- The read says in plain words which failures matter and whether the code, the ISA, the row or the environment is what's wrong, one Feature at a time.
- The run depth matches the Tool contract table row for the principal's words, and model judges ran only on a full test ("full test", "run the evals") or for a judged criterion about to ship.

## Anti-criteria

- Test never edits the ISA or the code; fixing is Build's or Modify's job.
- No row that writes data runs against production.
- An unavailable verifier (exit 2 from a judged row) is never reported as a fail; it is a skip.

## Safety gates

`IsaCheck.ts write-probes` flags rows that POST, PUT, PATCH, DELETE, insert, update or drop against a non-local target. The bunker row engine does not call it, so this intent is the caller. Read-only rows against production are fine. Local means the URL host (localhost, a `.local` or `.test` name, or a host labelled staging or preview), not a word in the path or query. The check matches patterns, so a custom script that writes is not caught: read an unfamiliar row before it runs against production.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Tool contract

| The principal says | Run |
|---|---|
| "quick check", "is it in sync" | well formed, sync, fast asserts |
| (default), "test it" | everything through the token-free deep checks |
| "full test", "run the evals" | everything, judges included |

```bash
ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" write-probes <repo>/ISA.md   # exit 1 = production write rows; see Safety gates
bun "$ROOT/skills/Development/Tools/IsaCheck.ts" bar <repo>/ISA.md
bun "$ROOT/LIFEOS/TOOLS/ISAGate.ts" <repo>/ISA.md
bun "$ROOT/skills/Development/Tools/Inventory.ts" sync <repo> <repo>/ISA.md     # exit 1 = gaps found, a result

# Criteria: the row engine runs each Test Strategy row and hands judged rows to Assay
# (glance rows to the judgment layer, eval rows to the Assay runner). Add --feature F<n> for one Feature.
RUN="$ROOT/LIFEOS/PULSE/Bunker/bin/bunker.ts"   # maintainer-side row engine; see the note below
bun "$RUN" test --isa <repo>/ISA.md --jobs 8 --json                    # fast asserts
bun "$RUN" test --isa <repo>/ISA.md --deep --asserts --jobs 8 --json   # token-free deep checks
bun "$RUN" test --isa <repo>/ISA.md --deep --jobs 8 --json             # judges included
```

Where the row engine is not installed (it is maintainer-side and not in the public release), run each row's command directly.

Assay resolves each row at the cheapest honest tier: code asserts first, then the judgment layer, then judges. A default Test typically runs in seconds; slow deterministic rows on the build lane take longer.

## Output format

A report with four parts, in this order:

1. **Well formed.** The ISA passes `IsaCheck.ts bar` (atomic criteria, one row each) and has no hard ISAGate finding. Advisory findings are listed, not blocking.
2. **Sync.** Surfaces the code exposes that no criterion names, and rows whose tool cell points at a file that doesn't exist, from `Inventory.ts sync`, plus the surface kinds the inventory cannot see, so a clean sync is never read as full coverage.
3. **Criteria.** Every ISC with its result at its Assay tier: pass, fail, skip (with reason), awaiting attestation, or provisional (a judgment-layer or judge answer that has not earned the right to decide). Provisional passes are listed apart from real passes.
4. **The read.** Which failures matter, in plain words, and whether the code, the ISA, the row or the environment is what's wrong, one Feature at a time.
