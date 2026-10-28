# SyntheticDataExpansion

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · References

A small seed corpus expanded into a diverse, schema-valid, deduplicated N-example dataset with provenance, via multi-turn Verbalized Sampling.

## Ideal State

- The corpus grows from the 5–20 example seed toward target N, every accepted example matching the schema exactly, semantically distinct from every seed example and every example accepted before it, and plausible, not absurd.
- Every accepted example passed all three acceptance checks: schema validation, near-duplicate dedupe (rejected when `Tools/Diversity.ts dedupe` gives TF-IDF cosine > 0.85 against any seed or accepted example), and confidence sanity (dropped when the model assigned `confidence > 0.20`, too typical, probably a rephrased seed).
- Every turn after the first had all examples accepted so far in its input and sampled from confidence < 0.10, and later turns' accepted examples sit further into the tails than earlier ones, pushed outward as the corpus grew.
- The run stopped when any termination condition was true (target N reached; the last turn rejected ≥40% of generations as semantic duplicates; three consecutive turns produced <2 accepted examples), and a diversity-collapse stop left a clear note in `summary.md` giving the actual diversity ceiling for this seed.
- `summary.md` reports the diversity index (`Tools/Diversity.ts index`, 1 minus mean pairwise TF-IDF cosine) for the seed and for the final corpus, and the corpus index is the higher of the two.
- `seed.json`, `schema.json`, `generations.jsonl` (every accepted example with provenance), `rejected.jsonl` (every rejected example with reason) and `summary.md` (final stats) exist under `~/.claude/LIFEOS/MEMORY/WORK/{slug}/synthetic-data/`, and the response points the user at them.

## Anti-criteria

- The output JSONL files are never summarized inline in the response in place of pointing the user at the files.
- The self-reported confidence is never trusted over the dedupe check.
- The prompts never use "probability" where "confidence" is the elicitation word; paper §H.3 found "confidence" outperforms "probability" specifically for VS-Multi.

## Inputs

- **Seed corpus** — 5–20 anchor examples, paste in full
- **Schema** — what each example must contain (fields, format, constraints)
- **Target N** — how many examples the final corpus should have
- **Optional: domain hints** — let the user steer the distribution

Typical consumers: eval sets (the Assay skill), prompt-injection test corpora, writing-style fine-tuning sets, synthetic Q&A pairs for retrieval evals.

## Tool contract

Each turn is a fresh generation request, but the model sees all previously accepted examples to enforce non-duplication. Every turn's candidates go through the dedupe tool before acceptance, and the index runs once on the seed and once on the final corpus. Run from `~/.claude`:

```bash
bun skills/BeCreative/Tools/Diversity.ts dedupe --accepted <seed + accepted so far> --candidates <turn output> [--threshold 0.85]
bun skills/BeCreative/Tools/Diversity.ts index <seed.json> <generations.jsonl>
```

Files are a JSON array or JSONL; a record with an `example` field is read as that example, so turn output and `generations.jsonl` pass as-is. Full contract: `Tools/Diversity.help.md`.

### Intent-to-Flag Mapping

| Request | Flag |
|---------|------|
| default near-duplicate cutoff | `--threshold 0.85` (omit) |
| "stricter dedupe", "allow closer variants" | `--threshold <lower or higher value in (0, 1]>` |
| examples accepted so far, seed included | `--accepted <file>` |
| this turn's generations | `--candidates <file>` |

## Gotchas

- **Confidence inflation across turns is normal.** The model will sometimes claim `confidence: 0.05` for examples that are only mildly novel. Trust the dedupe check, not the self-reported confidence.
- **The dedupe measure is lexical, so it catches copies and light edits, not paraphrases.** On a 2026-10-11 calibration, an exact copy scored 1.0 and a one-word edit 0.97, but a reworded paraphrase of a seed question scored 0.51 and passed. The confidence-sanity check and the turn prompt's distinctness instruction are the only other guards against paraphrased seeds; read `rejected.jsonl` and a sample of accepted examples before trusting the corpus.
- **Seed quality dominates.** If the seed corpus is itself narrow, no amount of VS-Multi expansion will reach a region the seed didn't hint at. Garbage in, mediocre out.

## Output format

Written to `~/.claude/LIFEOS/MEMORY/WORK/{slug}/synthetic-data/`:

- `seed.json` — the original seed corpus
- `schema.json` — the validation schema
- `generations.jsonl` — every accepted example with provenance (turn, confidence, generation-time)
- `rejected.jsonl` — every rejected example with reason (schema-fail, semantic-dup, low-quality)
- `summary.md` — final stats (N achieved, dedupe rate, seed and corpus diversity index from `Tools/Diversity.ts index`, turn count)

Each turn asks the model for 5 new examples and returns them as JSON, which `Diversity.ts dedupe --candidates` reads as-is:

```json
[{"example": <object matching the schema>, "confidence": <number>, "rationale": "<one sentence on what region of the distribution this comes from>"}]
```

## References

Verbalized Sampling Multi-turn (VS-Multi): Zhang et al. 2025, arXiv:2510.01171. The evidence base is in `ResearchFoundation.md`.
