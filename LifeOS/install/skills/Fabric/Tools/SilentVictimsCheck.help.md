# SilentVictimsCheck

Checks a SilentVictims output (`Intents/SilentVictims.md`) against the parts of its contract that code can judge. Whether the victims are real, specific and calibrated stays a judged check in the `fabric-silentvictims` suite.

## Usage

```bash
bun skills/Fabric/Tools/SilentVictimsCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, verdict, found, recommendations, problems}` |
| `--help` | Print usage |

## Checks

- One H1 opening `# Silent Victims: `, nothing before it, and exactly these H2 sections in order: ACTION/SYSTEM ANALYZED, VISIBLE STAKEHOLDERS, SILENT VICTIM SCAN, THE REVERSED TEST, SILENT VICTIM SEVERITY, OVERALL ASSESSMENT, RECOMMENDATIONS.
- No asterisks outside inline code.
- ACTION/SYSTEM ANALYZED is one prose paragraph of at most 100 words; VISIBLE STAKEHOLDERS is 2 to 8 bullets.
- SILENT VICTIM SCAN holds the five H3 categories in order (Temporal, Power, Information, Diffuse, Structural), each holding only `- Field: value` bullets. `Found` is Yes, Possible or No. A No carries only `Why not` (four or more words). A Yes or Possible carries `Who` and `Harm` plus the category's own fields and nothing else, and the fixed-value fields take only their listed values: Reversibility (Reversible, Partially reversible, Irreversible), Ignorance source (Natural complexity, Deliberate obscuring, Delayed effects), Individual harm (Negligible, Small, Moderate), Diffusion deliberate (Yes, No, Unclear), Self-reinforcing (Yes, No).
- THE REVERSED TEST opens with the word Yes, No or Partly, holds no table, and runs at most 150 words (a bullet list of objecting victims is fine).
- The severity table has the header `| Category | Found | Scale | Severity | Reversible |` and one row per category in scan order. Found matches the scan. A No row has Severity None and Reversible n/a; a found row has a Scale, a Severity of Low, Medium or High, and Reversible of Yes, Partly or No, with the temporal row agreeing with its Reversibility field.
- OVERALL ASSESSMENT opens on a line that is exactly one verdict, followed by 1 to 4 sentences, and the verdict follows the scan: NO when every category is No, POSSIBLE when the found ones are all Possible, PROBABLE or CONFIRMED when any is Yes.
- RECOMMENDATIONS are 1 to 8 bullets, each ending with the categories it addresses, such as `(Temporal, Diffuse)` (a full stop after is fine), none citing a category marked No, and together citing every category found. Under NO SILENT VICTIMS it is one bullet opening `None needed:`.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
