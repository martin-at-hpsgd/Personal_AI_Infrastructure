# BakeOff

Measure which vision leg, Astra (OpenAI via codex) or Claude (`Tools/ClaudeLeg.ts`), does each class of pixel-only work better here, and set the router's pick from the result.

## Ideal State

- Every mission in `Tools/BakeOff.ts` has rows from both legs under the same supervisor, and every row carries a verdict from that mission's verifier command.
- The report shows pass rate, median steps and median seconds per mission and leg, and the pick line it implies.
- `vision_pick:` in the principal's ComputerUse `Config.md` matches that pick line (`report --check-pick` exits 0), or the principal declined the change and that is recorded in the bake-off ISA.
- Refused runs (deny list, headless, preflight) appear in the report as refused.

## Anti-criteria

- Never hide or quit the principal's apps yourself to clear the deny list; a refusal names the app and the principal hides or quits it.
- Never delete the `CU Bake astra` or `CU Bake claude` shortcuts the Shortcuts mission leaves; deleting them is the principal's call.
- No actor's own report is scored, and no refused run is counted as a trial.
- `vision_pick:` is never written by hand-waving; it comes from `Tools/BakeOff.ts` results.

## Safety gates

- The Mac must be unlocked, and the deny list clear: credential apps quit, communications apps hidden.

## Tool contract

```bash
cd ~/.claude && bun skills/ComputerUse/Tools/BakeOff.ts run [--backend astra|claude] [--mission <id>] [--trials N] [--model <alias>]
cd ~/.claude && bun skills/ComputerUse/Tools/BakeOff.ts report [--check] [--check-pick]
cd ~/.claude && bun skills/ComputerUse/Tools/BakeOff.ts pick
```

Results append to `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/ComputerUse/bakeoff/results.jsonl`; run records land beside every other run.
