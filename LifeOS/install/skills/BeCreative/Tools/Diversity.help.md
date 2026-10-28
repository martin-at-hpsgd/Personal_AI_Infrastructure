# Diversity

Deterministic near-duplicate gate and diversity index for the SyntheticDataExpansion intent. Offline: no model or network call, so the same inputs always give the same numbers.

## Measure

Similarity is TF-IDF cosine over word unigrams and bigrams of each example's flattened leaf values. Object keys are ignored, so a shared schema does not inflate scores. IDF is computed over every text in the call. The score runs from 0 (no shared terms) to 1 (same terms in the same proportions).

## Commands

```
bun skills/BeCreative/Tools/Diversity.ts dedupe --accepted <file> --candidates <file> [--threshold 0.85]
bun skills/BeCreative/Tools/Diversity.ts index <file> [<file>...]
```

- `dedupe` prints one JSON line per candidate: `{index, maxSimilarity, nearest, duplicate}`. Each candidate is compared with every accepted example (pass seed plus accepted corpus) and every earlier non-duplicate candidate in the same batch. `duplicate` is `maxSimilarity > threshold`. `nearest` indexes the accepted list first, then kept candidates at `accepted.length + index`.
- `index` prints `{file, n, meanPairwiseSimilarity, diversityIndex}` per file, where `diversityIndex = 1 - meanPairwiseSimilarity`. Run it on the seed and on the final corpus; the corpus is more diverse when its index is higher.

## Input

A JSON array or JSONL. A record with an `example` field is read as that example, so turn output and `generations.jsonl` both work as-is.

## Exit codes

- `0` success
- `2` bad usage, missing file, or unparseable input
