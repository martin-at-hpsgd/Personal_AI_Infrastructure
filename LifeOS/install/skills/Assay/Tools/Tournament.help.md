# Tournament.ts

A single-elimination bracket over an injected pairwise judge. Every pair is judged twice with the order flipped (a winner that flips with the order is position bias and counts as a tie); the bracket runs again on shuffled seeding, and a different winner reports the result unstable. The result records the generator and judge model ids and flags a same-family pair.

```
bun Tournament.ts --candidates a.png,b.png,c.png --question "..." [--generator <model-id>] [--concurrency N] [--json] [--allow-identity] [--public] [--no-rerun]
```

Image candidates ride `VisionJudge.ts pairwise` (Gemini, which receives only public material: pass `--public` to say the images are public, otherwise a private-image bracket is refused). Every image path, the two-candidate first tier included, passes the vision identity guard: a path matching `headshot` is refused without `--allow-identity`. Text candidates ride `Judge.ts judgeTextPairwise` (the inference path). Exit 0 stable winner · 1 unstable or every pair tied · 2 verifier unavailable (DEFER, never a red). A `pairwise` Test Strategy row's tool cell is this command; `bunker test` dispatches it like an `eval` row (integrity lane, stage 2 by default, never liveness).
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

`--concurrency N` bounds simultaneous judge requests across the seeded bracket and its shuffled rerun; it defaults to 8. Bracket rounds remain sequential, but independent pairs and the two brackets run concurrently.
