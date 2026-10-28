---
contract:
  requires:
    - id: proposal
      path: LIFEOS/MEMORY/WORK/{slug}/simplify/proposal.md
      fields: [CHANGES, PRESERVED, PARITY]
      produce: 'Run the Simplify Propose intent and get the principal''s approval on {path}.'
---

# Apply

The approved simplifications landed in the target, with before-and-after parity proven and each group committed separately.

## Ideal State

- Only changes the principal approved are in the diff, and each one maps to a numbered row in the proposal.
- Every baseline check from the survey passes after the change with at least the same pass count, and every parity probe named in the proposal ran and passed. The report shows the before and after numbers side by side.
- After any delete, merge or inline, a fresh reference search for each removed name finds no remaining caller. Inside `~/.claude`, `ReferenceCheck.ts` reports no new missing reference.
- Each approved group is its own commit, staged by explicit path, with a message naming the proposal rows it lands. When the diff came from a delegate, the commit carries that delegate's co-author trailer.
- The report states the measured reduction (bytes, lines, files or symbols removed) next to the estimate in the proposal.

## Anti-criteria

- Never lands a group whose parity check fails or did not run. That group is reverted and reported as failed, and the remaining groups continue.
- Never edits a test or probe to make a simplification pass. A failing check means the change was wrong.
- Never deploys or pushes to a public remote. Landing in the target repo is the end of this intent, and shipping stays with the project's own deploy command.
- Never writes from a stale read. A file that changed since the survey is re-read and its finding re-checked before it is edited.

## Output format

- A table with one row per proposal row: landed, failed and reverted, or skipped, plus its commit hash.
- Parity before and after for each check.
- The measured reduction next to the estimate.

## Safety gates

- **Approval is per change.** The proposal's approved rows are the whole scope. A cut found while applying goes back through Propose.
- **P8 rows need their own yes.** An irreplaceable delete runs only when the principal approved that row by name.
- **Shared trees.** Run `git status` before the first edit. Foreign changes are left alone and never staged.

## Gotchas

- **USER files commit to the USER_DATA repo.** `LIFEOS/USER/**` and `LIFEOS/MEMORY/**` are symlinks into a separate private repo, so commit them with `git -C ~/.config/LIFEOS/USER`. A `~/.claude` commit captures nothing there. (Trim, same failure mode.)
