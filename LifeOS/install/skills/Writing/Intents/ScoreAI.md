# ScoreAI — Empirical AI-Detection Scoring (Pangram)

A measurement and a report: a real Pangram probability score that shows how a trained detector reads a text. It informs the principal and never decides whether a piece is good or ready.

## Ideal State

- Every reported number comes from a real run of the Pangram AI-detection model through `PangramScore.ts`: how much of the text reads as machine-generated to a trained detector, not to a word-list.
- A single score reports the AI% plainly, with its caveats. The report does not recommend a rewrite on the score alone; the principal decides whether any change is wanted.
- A batch compare scores several samples and ranks them in a sorted Sample / AI% / Verdict table; the point is relative comparison (which draft reads most human), not the absolute number.
- For voice work, a calibrated baseline (recommended) scores 2-3 passages of the principal's actual published writing in the same batch as the text under test, and the report says whether the gap is real signal or the detector maxing out on the genre/length.
- Every report states the three caveats listed under § Output format.
- When a text is scored before and after a revision, the report gives both numbers side by side and says what the revision changed. The score is information about the text, never a pass or fail condition on the revision, and a revision is judged by whether it reads better and keeps the principal's meaning.

## Anti-criteria

- Each call is billed, so the tool is never looped on trivial snippets.
- A single absolute number is never presented as a verdict or ground truth, and a low AI% is never reported as reading well.
- The score is never a gate: no draft is held, passed or called verified because of it.
- The tool is never used to make text undetectable. Text is not degraded, reworded or reshaped to move the number (no injected typos, broken sentences or humanizer passes), and the report does not frame a lower score as the goal of a revision.

## Output format

Batch compare, sorted by AI%:

```
| Sample | AI%  | Verdict          |
|--------|------|------------------|
| draft-C |  12% | Likely human     |
| draft-A |  64% | Mixed            |
| draft-B | 100% | AI generated     |
```

State these caveats when reporting:

- **Short samples are unreliable.** Detectors are weakest on under ~5 sentences. Pangram leans toward decisive 100/0 calls and will confidently flag a short human paragraph as 100% AI. **Always prefer longer passages** (a few hundred words) for a meaningful read.
- **One detector, not ground truth.** Pangram is among the strongest available, but it's still one model with real false-positive rates. Treat the score as a strong signal, not a verdict. The relative comparison (A vs B) is far more trustworthy than any single absolute number.
- **It measures detectability, not quality.** Low AI% means "reads human," not "reads well." Voice quality is still the `rewrite`/`detect` job against `WRITINGSTYLE.md` / `DA_IDENTITY.md`.

## Inputs

A bare AI% is hard to read without an anchor, so the calibrated baseline scores **known-human writing in the same batch as the text under test**:

- 2-3 passages of the principal's actual published writing: pieces from the voice corpus (`corpus_root` in `<voice_dir>/Corpus.md`), or results from the content index named by `corpus_cli` in the skill config when one is set.
- Reading the gap: if the principal's own published prose also scores high, the detector is maxing out on the genre/length, and the test text's score means less. If theirs scores low and the draft scores high, the gap is real signal.

## Tool contract

`~/.claude/LIFEOS/TOOLS/PangramScore.ts`:

| Invocation | What it does |
|------------|--------------|
| `bun ~/.claude/LIFEOS/TOOLS/PangramScore.ts "text"` | Score inline text |
| `bun ~/.claude/LIFEOS/TOOLS/PangramScore.ts --file path.md` | Score a file |
| `echo "text" \| bun ~/.claude/LIFEOS/TOOLS/PangramScore.ts` | Score stdin (best for long passages) |
| add `--json` | Raw Pangram response for parsing |

**Output:** headline verdict, `AI%` / `AI-assisted%` / `Human%`, segment counts. **Lower AI% = reads more human.**

**Auth/cost:** reads `PANGRAM_API_KEY` from `~/.claude/.env`. Roughly $0.05 per 1,000 words.

Score files directly (`--file`) or pipe each passage via stdin, one call after another; the tool polls per call.
