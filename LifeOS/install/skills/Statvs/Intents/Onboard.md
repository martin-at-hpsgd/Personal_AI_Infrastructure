# Onboard

A system, app or site moved onto the record through the five migration steps, each step proven before the next, so it reports into STATVS the one way every other system does.

## Ideal State

- A plan exists before any code: the streams the system will write (at least `deploy` and `app-health` for a live app), each stream's owner and class, the writer name, the view or views that replace its old store, and which of the five steps it starts at. The plan is shown to the principal, and code begins after their yes.
- Each new stream is registered in `streams.ts` in a reviewed commit with owner, class and `retention: "forever"`; `forward: true` only for a stream whose severity rows must reach the cloud tier.
- Step 1 (dual-write) is proven by rows from the new writer appearing in `tail` while the old store keeps writing. Step 3 is proven by `compare <view> --days 7` passing. Step 4 is proven by every reader of the old store pointing at the view. Step 5 (delete the old store, its lock code and its Vigil adapter) runs only after step 4 and only on a day `drill` and `restore-drill` both passed.
- A cloud app writes through its own outbox and bearer to the intake (ISA F8), never to a file on the principal's machine; when the intake is not built yet, the report says the app cannot report in until it is.
- The system's own ISA gains a criterion for each stream it now writes, so `Coverage` has something to check against.

## Anti-criteria

- No step 5 deletion before a passing seven-day compare and a same-day passing drill and restore drill.
- No customer tenant content in any row; a customer-class row carries operational facts and counts only.
- No new private log, lock or event store built beside the record as a shortcut.
- No stream registered without an owner path that exists.

## Safety gates

- **Deleting the old store is irreversible.** It needs the principal's explicit yes on that step, given after the compare and drill evidence is shown, even when earlier steps were approved.
- **Streams change the record's contract.** A `streams.ts` edit is a reviewed commit, staged and committed by explicit path, never folded into an unrelated change.

## Tool contract

```bash
rg -n '^  [a-z-]+:' LIFEOS/STATVS/streams.ts           # registered streams
bun LIFEOS/STATVS/Statvs.ts tail --stream <S> --n 20     # step 1 evidence
bun LIFEOS/STATVS/Statvs.ts compare <view> --days 7      # step 3 evidence
bun LIFEOS/STATVS/Statvs.ts drill --json                 # step 5 precondition
bun LIFEOS/STATVS/Statvs.ts restore-drill --json         # step 5 precondition
```

Library writers import the engine's append from `LIFEOS/STATVS/index.ts`; notice-worthy rows go through `writeEvent` in `LIFEOS/STATVS/lib/event.ts`.

## Output format

The plan as a table (stream · class · writer · view · current step), then for each step completed this run, the evidence that proves it.
