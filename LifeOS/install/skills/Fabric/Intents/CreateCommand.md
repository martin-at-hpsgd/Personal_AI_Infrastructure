# CreateCommand

A single runnable command that does what the request asks, built only from the options the tool's own documentation lists.

Our ideal-state port of Fabric's `create_command`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The command delivers what the principal wants from each input this job takes, inferred before anything is written and never asked for. A pasted help, usage, or man text means build the command for the tool it documents; a URL or a file means read it as that tool's documentation; a bare tool name or a plain-English objective naming a tool means the tool's own `--help` is the documentation; "this" means the tool and objective under discussion. A typed hint (an explicit objective line, a named target, a specific flag the request wants) overrides the default read.
- The output is one command that accomplishes the stated objective, with the objective's concrete values (targets, paths, counts, filenames, usernames, passwords) substituted in literally, so it would run as written. The values go in exactly as given; the command never adds a word, token, or inline `#` comment that characterizes, judges, or explains them — a username is not labelled weak, a delay or flag is not described as disabling or defeating a protection, nothing is annotated with its purpose or risk. The command carries values, not commentary.
- The command holds only the options the objective actually asks for. Each documented switch it uses maps to something the objective stated; it adds no extra convenience, speed, display, or verbosity switch the objective did not request, and it never substitutes a switch that trades away the behavior the objective asked for (for example picking a faster or lighter mode where the objective wanted thorough detection). When the objective is silent on a setting, the tool's own default stands and no switch forces it.
- The supplied documentation is the only source of truth for which options exist: every switch, option, and subcommand in the command appears verbatim in that documentation, and a capability the docs do not expose is left out of the command rather than invented.
- Thin, partial, or mismatched documentation still yields a command: build the single best runnable invocation the documented options allow, fill in the objective's concrete values, and silently drop whatever the docs do not cover. A documentation gap is answered by the command that omits the missing capability, never by a note about the gap, a refusal, a question, or a characterization of why a part is missing.
- The command is the whole output, done better than the upstream for a frontier model: no penetration-tester persona, no reasoning narration, no "virtual minutes", no markdown fence, and no note, warning, or explanation around it. The words are plain and exact and specific to this tool and this objective.
- `bun skills/Fabric/Tools/CreateCommandCheck.ts` passed on the exact output before it was delivered: the shape holds and the command parses as valid shell. Where no shell is available the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a switch, option, or subcommand the supplied documentation does not list, and never a guessed or placeholder flag standing in for one the docs lack.
- Never a switch the objective did not ask for, and never one that weakens or swaps out the asked-for behavior (a faster or lighter mode in place of the thorough one the objective wanted); when the objective says nothing about a setting, force nothing and let the default stand.
- Never a word, token, or inline `#` comment that characterizes or judges a value or the command — a credential called weak, a flag described as disabling or bypassing a protection, an argument annotated with its purpose or risk. Values go in bare.
- Never a note, question, refusal, or explanation when the documentation is thin or mismatched; emit the best command the documented options allow and drop the uncovered part in silence.
- Never an unfilled placeholder (`<target>`, `<file>`) where the objective gave a concrete value, and never more than one command.
- Never markdown around the command (a code fence, bold, a heading, a bullet), and never a note, warning, caveat, or "Here is the command" line before or after it.
- Never the penetration-tester persona or reasoning narration from the upstream prompt, and never the old Fabric pattern text run as the prompt for this request.
- Never a command that does not parse as valid shell.

## Evals

- suite: fabric-createcommand — code checks on shape (one command, no markdown, no prose, no placeholder) and a shell-syntax parse, plus judged checks on using only documented flags and meeting the objective.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The objective: what the command must do, in plain words (often the first line of the input).
- The tool's documentation: its `--help`, usage, or man text, pasted, at a URL, in a file, or read from the named tool's own help.
- An optional explicit flag the request wants included, which overrides the default read of the objective.

## Safety gates

- The deliverable is the command as text; this intent composes it and never runs it. Composing a command is not permission to execute it.
- Only options the provided documentation lists may appear; a missing capability is reported by omission, never by a fabricated switch.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/CreateCommandCheck.ts <file|-> [--json]
#   exit 0: shape holds and the command parses; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

To read a tool's documentation from a URL or a YouTube link, follow `Intents/ExecutePattern.md` § Tool contract rather than restating it.

## Output format

```
<one runnable command, with the objective's concrete values in place>
```

The command is the entire output: no fences, no prose, no notes.

## References

- Upstream: `Patterns/create_command/system.md` (a fixed penetration-tester persona that builds a command from a tool's `-h` output, as bare text).
- `Tools/CreateCommandCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching a tool's documentation from a URL or a YouTube link.
