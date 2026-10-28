# Watermark

Scan text for watermark and steganography signatures that are readable **without any key** — the character-level covert channels that live directly in the bytes.

## Ideal State

- Every report states the hard limit in § Output format: the scan cannot detect sampling-time statistical watermarks (Kirchenbauer green-list, Aaronson/Gumbel, Google SynthID-Text, Anthropic's announced in-text mark).
- Each keyless hit (zero-width / invisible characters, variation-selector and Unicode Tags-block steganography, bidi-control overrides, homoglyph / mixed-script substitution, anomalous whitespace) is reported with its codepoint, name, and byte offset, from a `WatermarkScan.ts` run.
- The weak trigram-repetition heuristic is reported as a hint, never a verdict.

## Anti-criteria

- A clean scan is never presented as meaning the text is unwatermarked or human-written.

## Output format

The hard limit, stated every time:

It **cannot** detect sampling-time statistical watermarks: Kirchenbauer green-list (arXiv:2301.10226), Aaronson/Gumbel (arXiv:2307.15593), Google SynthID-Text (Nature s41586-024-08025-4), or **Anthropic's announced in-text mark** (support.claude.com/en/articles/16266773). Those bias token choice using a secret key and leave no readable artifact in a single text — detection is key-gated by mathematical design. A clean scan does **not** mean the text is unwatermarked or human-written. Run `--explain` for the detectable-vs-impossible breakdown.

## Tool contract

```bash
bun ~/.claude/LIFEOS/TOOLS/WatermarkScan.ts --file <path>
# also: --text "..."  |  piped stdin  |  --json for machine output  |  --explain for the full model
```

## Gotchas

- Copy-paste through HTML or a summarizer strips most invisible characters, so a wild sample that scans clean may just have been laundered by transport.
