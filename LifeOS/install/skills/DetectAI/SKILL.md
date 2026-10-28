---
name: DetectAI
evals:
  deterministic:
    - command: "printf 'ab\\342\\200\\213cd' | bun LIFEOS/TOOLS/WatermarkScan.ts --json | bun -e 'const j = JSON.parse(await Bun.stdin.text()); const hit = j.classes.flatMap(c => c.sample).some(x => x.codepoint === \"U+200B\" && x.index === 2); process.exit(hit ? 0 : 1)'"
      falsifier: "WatermarkScan.ts --json, given a fixture with U+200B at offset 2, reports no hit with that codepoint and offset"
  manual:
    reason: "an AI-writing assessment requires a reviewer to judge whether reported signals support the conclusion for the supplied prose"
    falsifier: "the reviewer finds the verdict overstates the evidence or fails to distinguish heuristic signals from proof"
metadata:
  short-description: "Detect AI writing patterns, statistical signals, Pangram scores, and hidden watermark characters. Excludes rewriting, plagiarism, and image detection."
version: 1.2.1
description: Detects AI-generated writing: heuristic audit against known AI patterns, statistical signals (entropy, burstiness), an empirical Pangram score, and a keyless scan for watermark or steganography signatures (invisible characters, homoglyphs, bidi). USE WHEN detect AI writing, is this AI, AI detection, AI detector, did an AI write this, does this sound like AI, pangram, scan for AI tells, AI-isms, burstiness, is this watermarked. NOT FOR rewriting prose (a writing skill), plagiarism, judging quality.
---

# DetectAI

Answers two questions, *how much does this read as machine-generated?* and *does it carry an embedded mark?*, with four independent measures: a heuristic audit against a severity-tiered pattern catalog, which explains why each flag fired; deterministic statistical signals (`LIFEOS/TOOLS/StatSignals.ts`), each labeled with its reliability; an empirical Pangram score, which costs money and needs a key; and a keyless watermark scan for covert channels in the bytes. Detect, the statistics and Watermark are free and need no key. The measures disagree often, and the disagreement is the useful part: text can clear every pattern on the list and still score 100% AI, which means the tells are structural rather than lexical, and a watermark hit is bytes-level proof whatever the other measures say.

## Ideal State

- Every answer rests on measures that actually ran (the pattern catalog, `StatSignals.ts`, a recorded Pangram run, `WatermarkScan.ts`), and the report names which ran and which did not.
- A plain "is this AI?" with a key configured gets the heuristic audit and the Pangram score side by side, and where they disagree the report says what the gap means.
- No report treats one signal as proof of authorship: scores carry their length and baseline caveats, and a clean watermark scan is never read as "human-written".
- The text under review is reported on, never rewritten.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Detect** | "scan for AI tells", "flag AI patterns", "does this sound like AI", "audit this for AI-isms", "statistical signals", "burstiness", "entropy" — heuristic + deterministic statistical pass, no key needed | `Intents/Detect.md` |
| **Score** | "score this for AI", "is this AI generated", "AI detection score", "pangram", "compare these drafts" — empirical, needs key | `Intents/Score.md` |
| **Watermark** | "is this watermarked", "detect a watermark", "scan for hidden/invisible characters", "steganography", "zero-width chars" — keyless byte-level signature scan, no key needed | `Intents/Watermark.md` |

"Is this watermarked?" routes to Watermark, which answers a different question: whether a covert channel is embedded in the bytes, not whether the prose reads as AI. For "is this AI and is it marked?", run Score plus Watermark.

| File | Read when |
|------|-----------|
| `Setup.md` | getting or storing the Pangram key, credits and rates, troubleshooting 401/402/429 or a stalled task |

## Data & Config

Detect and Watermark need no setup. Score needs `PANGRAM_API_KEY` in `~/.claude/.env` (prepaid credits, about $0.05 per 1,000 words); key, credits, verification and troubleshooting are in `Setup.md`.

## Gotchas

- **Never degrade writing to beat a detector.** Injected typos, broken sentences, and "humanizer" laundering damage the prose and don't fix the underlying problem. If text must read human, the fix is a human in the loop.

## Examples

- "Scan this post for AI tells, don't change it" → **Detect**: tiered P0/P1/P2 flag report, each marked clear-problem vs judgment-call, no edits.
- "Is this AI generated?" → **Score**: single Pangram run, headline verdict plus AI/AI-assisted/human percentages, with the length caveat stated if the sample is short.
- "Which of these three drafts reads most human?" → **Score** in batch-compare mode: one call per draft, ranked table, relative comparison foregrounded over absolute numbers.
- "Did my rewrite actually help?" → **Score** before and after, with two known-human passages scored in the same batch as calibration.
