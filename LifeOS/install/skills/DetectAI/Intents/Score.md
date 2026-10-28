# Score — Empirical AI-Detection (Pangram)

Run text through the Pangram detection model and report a real probability. This is the measurement half of the skill: `Detect` guesses from a pattern catalog, `Score` asks a trained detector.

## Ideal State

- Every reported score comes from a completed `PangramScore.ts` run that reached `STAGE_SUCCESS` and appended its record (with a SHA-256 of the normalized text) to `LIFEOS/MEMORY/OBSERVABILITY/pangram-runs.jsonl`, so a claim that the detector ran on a specific text is checkable.
- A single-score report gives the AI% plainly, with the headline verdict and segment counts; if the sample is under ~5 sentences, it states that the number is unreliable at that length before reporting it, not after.
- Every report states, alongside the number: the sample length and the short-sample caveat if it applies, whether a human baseline was scored and what it came out at, and that this is one detector (among the strongest available) with real false-positive rates, a strong signal, not a verdict.
- A batch compare ranks the samples in a table, and the relative ordering is the point, not any single number.
- Whenever the answer will inform a decision about a person's writing, and whenever someone asks whether a rewrite actually helped, 2-3 passages of writing known to be human (ideally same author, genre and length) were scored in the same batch, and the result is read as a gap: baseline low and test high is real signal; baseline also high means the detector is saturating and the test score is not reported as a finding.

## Anti-criteria

- Never present a Pangram score as proof that a named person used AI. The false-positive rate is real and the failure mode is accusing a human, so no number here justifies that claim.
- When `PANGRAM_API_KEY` isn't configured, never fall back to a heuristic guess and present it as a score.
- If the tool exits 1, nothing is reported as a score.
- The tool is never rebuilt and the API call is never reimplemented inline.
- Calls never run in parallel: the realtime endpoint caps at 5 QPS and parallel batches trip 429.

## Output format

### Batch compare

```
| Sample  | AI%  | Verdict      |
|---------|------|--------------|
| draft-C |  12% | Likely human |
| draft-A |  64% | Mixed        |
| draft-B | 100% | AI generated |
```

## Safety gates

- Requires `PANGRAM_API_KEY`. If it isn't configured, say so and point at `Setup.md`.

## Tool contract

Shared tool: `~/.claude/LIFEOS/TOOLS/PangramScore.ts`.

| User intent | Invocation |
|-------------|------------|
| Score text pasted into the conversation | `bun ~/.claude/LIFEOS/TOOLS/PangramScore.ts "text"` |
| Score a file | `bun ~/.claude/LIFEOS/TOOLS/PangramScore.ts --file path.md` |
| Score a long passage (safest — no shell quoting to mangle) | `echo "text" \| bun ~/.claude/LIFEOS/TOOLS/PangramScore.ts` |
| Need the raw numbers to build a table | add `--json` |

Output: headline verdict, `AI%` / `AI-assisted%` / `Human%`, segment counts. **Lower AI% = reads more human.**

Every call bills against prepaid credits (about $0.05 per 1,000 words), so don't loop it on trivial snippets. Each call submits an async task and polls it to `STAGE_SUCCESS`. A task that never reaches `STAGE_SUCCESS` writes no record and exits non-zero, so a stalled request can never masquerade as a measurement: re-run rather than reporting anything. HTTP 402, 429 and the other failures are in `Setup.md` § Troubleshooting.

## Gotchas

- **Short samples are unreliable.** Detectors are weakest under ~5 sentences. Pangram leans toward decisive 100/0 calls and will flag a short human paragraph as 100% AI. Verified in testing when the skill was built (2026-07-27): a plain-voice human paragraph and deliberate AI slop both scored 100% at roughly four sentences each. Score passages of a few hundred words or don't bother.
- **An absolute score without a baseline says little.** If the human baseline scored in the same batch also maxes out, the detector is saturating on the genre and length, not on the text. The A-vs-B comparison is the trustworthy part.
