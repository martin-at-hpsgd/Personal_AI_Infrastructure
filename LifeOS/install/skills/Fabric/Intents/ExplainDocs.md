# ExplainDocs

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Gotchas · Output format · References

A working guide to a tool, product or interface: what it does, why people use it, its common syntax, the jobs people use it for as ready-to-run commands, and the options that matter, drawn from its documentation or from established knowledge of it.

Our ideal-state port of Fabric's `explain_docs`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The guide delivers what the principal wants from this input, inferred before a word is written and never asked for. Pasted documentation (a man page, `--help` output, a README, an API reference, a vendor guide) means a better guide to the tool those docs describe, built from those docs, read in full. A URL or a file means the same for the documentation it points at. A bare tool or product name ("rsync", "jq", "the GitHub CLI") means a guide to its current stable release from established knowledge of it. A question about a tool ("how do I extract one file with tar?") means the guide with the asked job as its first use case, answered with the exact command. "This" or "that" means the tool or documentation already in the current conversation. Anything else that explains how to use something (an HTTP API, a library, a config format, a desktop app, a device) is read as documentation of that thing, and its syntax takes the form that thing really has (a request line, a function signature, a menu path), never an invented command line. Only an input that describes nothing usable gets the one `**No tool to explain:**` line. A typed hint ("just the networking flags", "for a beginner", "on macOS") overrides the default read and narrows or pitches the guide to it.
- The title names the tool and the read ("rsync, from the pasted man page", "tar, for extracting one file", "jq"), so a wrong read is visible at a glance.
- The output carries the four sections the upstream pattern defines, in its order: OVERVIEW, HOW TO USE IT, COMMON USE CASES, and MOST IMPORTANT AND USED OPTIONS AND FEATURES.
- What It Does says what the tool is and does in about 25 words; Why People Use It says what problem it solves better than the obvious alternative, in about 25 words. Both are specific to this tool: neither sentence could describe a different tool and stay true.
- Most Common Syntax gives the general invocation form in a code block, with the placeholders a reader fills in (`rsync [OPTIONS] SRC DEST`), and a sentence on any part of it that behaves in a way a reader would not guess.
- Each common use case names a job in the words a user would use for it and gives one complete command that does that job, with realistic example values, which a reader could paste and run. The use cases are the jobs people actually reach for this tool to do, the most common first, between three and ten of them.
- Each option or feature names the flag, setting or capability exactly as the tool spells it, says what it does, and says when to reach for it or what goes wrong without it. The list holds the options that do the most work in practice, not the alphabetical first page of the docs.
- Every flag, subcommand, argument order, default and output described is the one the tool really has. When the input is documentation, every option and command is supported by that documentation, so it works on the version documented; general knowledge may choose which jobs are common, never add an option the docs do not give, and behavior the docs do not state is left out or said to be undocumented. When behavior differs by version, platform or implementation (GNU against BSD, a flag added in a later release), the entry it affects says so.
- A source is read in full before anything is written (`Intents/ExecutePattern.md` § Tool contract covers fetching URLs and YouTube links).
- The words are plain and exact. Commands, flags, paths and values appear in inline code exactly as typed.
- `bun skills/Fabric/Tools/ExplainDocsCheck.ts` passed on the exact output before it was delivered, with `--source` set to the input whenever the input was documentation text or a file. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a flag, subcommand, endpoint or default the tool does not have, and never one the given documentation does not support when documentation was given.
- Never a command that would fail or do something other than the job its line names (the wrong argument order, a missing required argument, a flag that belongs to a different subcommand).
- Never a dangerous command (one that deletes, overwrites or force-pushes) without its safe form or a dry run given in the same entry.
- Never a use-case command that still carries a placeholder (`<file>`, `{name}`) or is the general syntax repeated, instead of a real command with example values.
- Never a restatement of the docs in their own order and words; the guide is shorter and more usable than its source.
- Never an invented command-line tool for a product whose interface is an API, a library or an app.
- Never a question back to the principal about which tool, version or level they mean when the input and the defaults settle it.
- No preamble, persona, reasoning narration, closing offer, or free-standing "Note:" and "Warning:" lines. A caution that matters goes inside the entry it belongs to.
- Never a source read from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-explaindocs — code checks on the title, the four sections, the overview lengths, the use-case and option line shapes, and documented flags; judged checks on fidelity to the docs, commands that work, real options for a bare tool, the asked job first, and an API's real syntax.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted documentation, a URL, a file path, a bare tool or product name, a question about a tool, or "this"/"that" for what is already in the conversation.
- An optional hint setting the scope, the reader's level or the platform.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExplainDocsCheck.ts <file|-> [--source <input-file>] [--tool <name>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| The run has | Flag | Effect |
|---|---|---|
| (any guide) | `<file>` or `-` | Check the saved draft or stdin |
| documentation text or a file as the input | `--source <input-file>` | Also require every long flag (`--name`) in the use cases and options to appear in the documentation |
| a command-line tool whose every use-case command starts from it | `--tool <name>` | Also require each use-case command to contain that name |
| a caller that wants the result as data | `--json` | Print `{ok, noTool, title, sections, useCases, options, problems}` |

## Gotchas

- Flag spellings diverge between implementations of the same tool: `sed -i` takes a required suffix argument on BSD and macOS and an optional attached one on GNU, and `tar`, `find`, `date` and `xargs` differ the same way. A command written for one breaks on the other, so the entry names the implementation it is for.

## Output format

~~~markdown
**{tool name}, {the read, e.g. from the pasted man page}**

## OVERVIEW

What It Does: {about 25 words}

Why People Use It: {about 25 words}

## HOW TO USE IT

Most Common Syntax:

```
{general invocation form with placeholders}
```

## COMMON USE CASES

- For {a job in the user's words}: `{complete command with example values}`
- …

## MOST IMPORTANT AND USED OPTIONS AND FEATURES

- `{flag or setting as spelled}`: {what it does, and when to reach for it}
- **{feature name}**: {what it does, and when to reach for it}
- …
~~~

- What It Does and Why People Use It each hold 8 to 35 words.
- COMMON USE CASES holds 3 to 10 entries, each one line in the form shown, the command in inline code. A caution about an entry follows the command on the same line.
- MOST IMPORTANT AND USED OPTIONS AND FEATURES holds 3 to 15 entries, each opening on the flag in inline code or the feature in bold, then a colon and at most 60 words.
- Input that describes nothing usable is the single line `**No tool to explain:** {what the input is instead}`.

## References

- Upstream: `Patterns/explain_docs/system.md` (an "expert at explaining" persona told to take a deep breath and think step by step; four H1 sections, OVERVIEW with a 25-word What It Does and Why People Use It, HOW TO USE IT with the most common syntax, COMMON USE CASES as `For X: command` lines, and MOST IMPORTANT AND USED OPTIONS AND FEATURES; told to read any input as tool documentation and to output no warnings or notes).
- `Tools/ExplainDocsCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching URLs and YouTube transcripts.
