# Deliver

Hands a passing artifact over to the requested directory behind the critique and Proof gate.

## Ideal State

- The intended artifact is copied to the requested directory only with a current passing critique and completed applicable domain checks.
- An MP4's adjacent `review/` tree accompanies it.
- The critique counts as current only with literal `pass`, an exact `artifactMtime` match, and, when it carries `artifactSha256`, a sha256 match against the artifact's bytes, plus a passing Proof receipt from `Proof.ts run`.

## Anti-criteria

- A cap-hit or unavailable critique is never handed over as done.
- A receipt written by the critique alone never stands in for the passing Proof receipt.
- Never delivers anywhere but the intended hand-over location, since existing destination files can be overwritten.

## Tool contract

```text
bun skills/ArtDirection/Tools/Deliver.ts --artifact <file> [--critique <Critique.json>] --to <dir>
```

The critique defaults to `Critique.json` beside the artifact. A critique of other bytes is stale even if the mtime matches. Deliver canonicalizes destinations to reject source replacement aliases (hard links included), and rejects review-source symlinks or copying review into itself. It does not recompute quality scores; keep report and artifact paired and re-critique any revision. Refusals exit 1 with the reason; success reports copied paths and byte counts.
