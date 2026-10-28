# MindVirusCheck

Checks a MindVirus output (`Intents/MindVirus.md`) against the parts of its contract that code can judge. Whether the evidence comes from the content, whether advocacy is kept apart from manipulation, and whether the inoculation is specific stay judged checks in the `fabric-mindvirus` suite.

## Usage

```bash
bun skills/Fabric/Tools/MindVirusCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, verdict, claims, exploits, problems}` |
| `--help` | Print usage |

## Checks

- One H1 opening `# Mind Virus Check: ` as the first line, nothing between it and the first section, and exactly the nine H2 sections in order: CONTENT ANALYZED, CORE CLAIMS, COGNITIVE EXPLOIT ANALYSIS, TERM REDEFINITION CHECK, FALSIFIABILITY CHECK, SOCIAL ENFORCEMENT PATTERNS, MIND VIRUS VERDICT, INOCULATION, KEY INSIGHT. No section is empty, and only INOCULATION holds subheadings.
- CONTENT ANALYZED is one prose paragraph of at most 60 words.
- CORE CLAIMS is a numbered list of 1 to 5 claims, numbered from 1 with no gaps, each at least three words.
- COGNITIVE EXPLOIT ANALYSIS is only the table `| Exploit Type | Present? | Evidence |` with its separator and exactly six rows in order (Fear-based, Guilt-based, Identity-based, Authority-based, Zero-sum, Unfalsifiability). `Present?` is Yes, Partial or No; every row has evidence, and a Yes or Partial row's evidence is at least four words.
- TERM REDEFINITION CHECK is either the single line `None found: …` or bullets opening on a quoted term and a colon (`- "term": …`) with at least six words after it.
- FALSIFIABILITY CHECK is exactly three bullets: `Can the core claims be tested:` Yes, No or Partially; `What would disprove them:` at least two words; `Acknowledges it could be wrong:` Yes or No. A short note may follow an enumerated value.
- SOCIAL ENFORCEMENT PATTERNS is exactly three bullets: `Questioners are:` Answered, Dismissed, Attacked, Excluded or Not addressed; `Doubt framed as moral failure:` Yes or No; `Loyalty tests:` No, or `Yes: <the test>` of at least three words.
- MIND VIRUS VERDICT is one line: CLEAN, MILD INFECTION PATTERNS, SIGNIFICANT MIND VIRUS MARKERS or SEVERE MIND VIRUS, an em-dash or colon, and a reason of at least five words.
- The verdict agrees with the fields. CLEAN fails when any exploit is Yes, questioners are attacked or excluded, doubt is framed as moral failure, or a loyalty test is named. SIGNIFICANT and SEVERE fail unless at least one shows resistance to correction: Unfalsifiability Yes or Partial, claims testable No or Partially, questioners attacked or excluded, doubt framed as moral failure, or a loyalty test.
- INOCULATION is the single line `Not needed: …` exactly when the verdict is CLEAN. Otherwise it holds the three H3 groups in order (Questions that expose the manipulation, Evidence that would test the claims, Reframings that restore falsifiability), each with 1 to 4 bullets and nothing else.
- KEY INSIGHT is one line, one sentence, at most 40 words, not a list item.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage, an unknown flag, or unreadable input
