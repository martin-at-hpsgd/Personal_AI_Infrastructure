# PortDuel.ts

Puts a Fabric port intent head to head with the upstream pattern it replaces, on held-out inputs written before the port.

```
bun skills/Fabric/Tools/PortDuel.ts <Intent> [--heldout <file>] [--concurrency N] [--json]
```

- Cases come from `Evals/HeldOut/<Intent>.json`: `{ "intent": "<Intent>", "cases": [{ "id", "pattern", "input" }] }`, at least three. `pattern` names the upstream pattern the case is compared against (a merged intent names a different sibling per case). An optional `expects` states what the requester wants, written from the principal's stated preferences and the upstream deliverable, never from the port; the judge sees it beside the request.
- The same generator (the Sonnet lane, Claude subscription) answers each case twice: with `Intents/<Intent>.md` as the system prompt and with `Patterns/<pattern>/system.md`.
- Assay's `Tournament.ts` judges each pair in both orders, with the judge on the OpenAI lane (`LIFEOS_INFERENCE_VENDOR=openai`) so the judge is outside the generator's family. A winner that flips with the order is a tie, and the pair is judged again on the shuffled rerun.
- Candidates and verdicts are kept under `LIFEOS/MEMORY/STATE/Evals-Results/fabric-duels/<Intent>/<timestamp>/`.

| Exit | Meaning |
|------|---------|
| 0 | the port won more than half the cases |
| 1 | it did not |
| 2 | a generation or the judge was unavailable for some case (no verdict) |
