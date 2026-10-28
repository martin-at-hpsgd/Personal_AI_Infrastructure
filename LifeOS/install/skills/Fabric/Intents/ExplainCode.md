# ExplainCode

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

An explanation of code, configuration or security tool output: what it actually does or means, in fixed sections, with the principal's question answered first when there is one.

Our ideal-state port of Fabric's `explain_code`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The output delivers what the principal wants from this input, inferred before a word is written and never asked for. Pasted code, a file path or a URL to a source file means what the code does as a whole and how it gets there, including anything it does that its names would not lead a reader to expect. Pasted configuration (a server block, a compose file, a manifest, a policy) means what the settings that matter do with these values, and which of them are risky or wrong. Pasted security tool output (a port scan, a scanner report, a linter or dependency audit) means what the findings mean for the system: how serious each is, what an attacker could do with it, and what to check or change first. A bare question or construct with no artifact ("what does `set -euo pipefail` do", "explain this regex") means a direct answer with the smallest example that shows it. "This" or "that" means the code, configuration or tool output already in the conversation. A question or hint typed with the input ("why does this return every row", "is this safe to expose", "just the auth part") overrides the default read, and the answer to it comes first.
- The output carries the sections the upstream pattern defines and only the ones this input calls for: `## ANSWER` when the input asks a question or is a bare question, `## EXPLANATION` for code, `## SECURITY IMPLICATIONS` for security tool output, and `## CONFIGURATION EXPLANATION` for configuration. An input that mixes kinds gets each matching section, in the order the Output format shows.
- The ANSWER section answers the question in its first sentence ("Yes, but only behind the proxy", "Because `id` is concatenated into the query"), then gives the reason drawn from the input.
- The EXPLANATION section opens with one or two sentences on what the code does as a whole: its purpose and its result. It then walks through the parts that carry the behavior in the order they run, naming the real functions, variables and lines in backticks, and skips lines whose meaning is obvious.
- What the code actually does wins over what it seems meant to do. Exact counts, bounds, defaults, return values and side effects are stated as the code has them (a loop written `i <= tries` runs `tries + 1` times), and a bug, swallowed error, race or off-by-one the code really has is named plainly as part of what it does.
- The SECURITY IMPLICATIONS section names each finding from the tool output that matters, with the port, path, rule, package or line it came from, says how serious it is and why for this system, and orders findings so the most dangerous comes first. Routine or expected results are left out or said to be fine in one line. A known flaw is tied to a listed version only when that version falls in its affected range, and a match read from a version banner is said to depend on the patch level, because a banner does not show a backported fix.
- The CONFIGURATION EXPLANATION section names each setting that changes behavior, says what it does with this value (and how that differs from the default where the difference matters), and flags the settings that are risky or wrong with the reason and the safer value.
- Behavior that depends on something outside the input (an imported function, an environment variable, a server default, a version) is said to depend on it, with what would change, never filled in as a guess stated as fact.
- A source is read in full before anything is written (`Intents/ExecutePattern.md` § Tool contract covers fetching URLs and YouTube links).
- The words are plain and exact, specific to this input: a reader could not move a sentence to a different snippet and have it still be true. Identifiers, flags, values and commands appear in backticks exactly as written in the input.
- `bun skills/Fabric/Tools/ExplainCodeCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a line-by-line paraphrase that restates each line in English ("Line 3 declares a variable called `i`") instead of explaining what the code does.
- Never a count, bound, default, return value, CVE, version or vulnerability the input does not support, and never a description of what the code was presumably meant to do in place of what it does.
- Never a question back to the principal about what kind of input this is or what they want, when the input settles it.
- Never a section the input does not call for, and never a heading outside the four upstream sections.
- No preamble, persona, reasoning narration, closing offer, or free-standing "Note:" and "Warning:" lines: the output is the sections and nothing else, and a caution that matters goes inside the section it belongs to.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-explaincode — code checks on sections and literal facts, plus judged checks on fidelity to what the code does, finding severity, risky settings and the inferred read.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted code, configuration or security tool output; a file path; a URL to a source file or raw paste; or "this"/"that" for what is already in the conversation.
- Optional: a question or hint typed with it.
- Or a bare question about a code construct, command, flag or setting, with no artifact.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExplainCodeCheck.ts <file|-> [--question] [--kind code|config|security] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| The run has | Flag |
|---|---|
| a question in the input, or a bare question with no artifact | `--question`: `## ANSWER` must be present and first |
| code, configuration or security tool output as the input (repeat for a mix) | `--kind code`, `--kind config`, `--kind security`: the matching section must be present |
| a caller that wants the result as data | `--json` |

## Output format

Only the sections the input calls for, in this order:

```markdown
## ANSWER

{the answer in the first sentence, then the reason from the input}

## EXPLANATION

{what the code does as a whole, then the parts that carry the behavior, in the order they run}

## SECURITY IMPLICATIONS

{each finding that matters, most dangerous first, with where it came from and what it allows}

## CONFIGURATION EXPLANATION

{each setting that changes behavior, what it does with this value, and the risky ones flagged}
```

Lists and `###` sub-headings may be used inside a section. Nothing appears before the first section or after the last.

## References

- Upstream: `Patterns/explain_code/system.md` (an "expert coder" persona told to take a deep breath and think step by step; four conditional sections, EXPLANATION, SECURITY IMPLICATIONS, CONFIGURATION EXPLANATION and ANSWER, each written with a trailing colon; and the one rule "Do not output warnings or notes—just the requested sections").
- `Tools/ExplainCodeCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching URLs and YouTube transcripts.
