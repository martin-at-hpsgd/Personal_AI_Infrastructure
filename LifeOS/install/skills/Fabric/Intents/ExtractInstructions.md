# ExtractInstructions

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

The steps a reader needs to do the task a source teaches, in the order they must be done, with what it achieves and what to have ready, under a title that names the task and the read.

Our ideal-state port of Fabric's `extract_instructions`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The output gives what the principal actually wants from this input, inferred before a word is written and never asked for: a procedure someone could follow without the source in front of them. The read follows what the input is. A pasted artifact (a video transcript, a tutorial, a README, a recipe, a forum answer, a runbook) means the procedure it teaches. A URL, a YouTube link or a file means the same for the source it points at, read in full. A bare topic or task ("changing a bike inner tube", "how to jump-start a car") means the standard method a skilled practitioner would teach, the safe and settled one. A question ("how do I rotate this key?", "what do I do first?") means the steps that answer it. "This" or "that" means the procedure the current conversation arrived at, as finally settled rather than as first tried. A typed hint ("just the install part", "only the advanced method", "for Windows") overrides the default read and narrows the steps to it.
- The reply is the finished instructions and nothing else, starting on the `# Instructions: ` line: no opening remark, no plan, no draft written into a shell command, heredoc or file, no tool call shown and no checker output. Any checking happens out of the reader's sight before the reply.
- The title names the task as what the reader will be able to do and, for a source, the source ("Instructions: Sharpening a Kitchen Knife on a Whetstone, From a Cooking Video"), so a wrong read is visible at a glance.
- The objectives say what following the steps achieves or teaches, one outcome per bullet in at most 15 words, as many as the source really has and never more than ten. Each names a concrete outcome of this procedure ("Seat the new tube without pinching it", "Confirm the stone is flat before sharpening"), never a rewording of the title or a generic goal.
- When the input names materials, tools, ingredients, accounts, versions or prerequisites, a "You need" section lists them once, with the quantities, sizes and versions it gives. It holds only what the reader must have before step 1 that no step already names where it is used; when it names none, or every item would repeat a step, the section is left out.
- Each numbered step and each sub-step is exactly one action, written as an instruction that opens on its verb, concise enough to follow at a glance (most fit in 25 words, none passes 40), and concrete enough that the reader knows when it is done ("Stroke each side ten times at 15 to 20 degrees", then a separate "Feel along the opposite side for a burr", not "Sharpen the blade properly"). Beside its one action, a step carries only the warning that guards it and the result that shows it worked. Two actions joined by "then", "and" or a semicolon are two steps.
- Moving the speaker's voice into the reader's keeps who acts and who is asked exactly as the source has it. The speaker's "me", as the person running the procedure, becomes "you" (an alert that "pages me" pages you, and a gate that "waits for my approval" waits for yours rather than becoming a self-check), and an action the source gives to a tool, a system or another person stays theirs.
- The source's own grouping is kept. When it numbers, names or groups its steps ("step one", "the second layer", "three defenses"), each of its steps stays one numbered step, in its order and with its own boundaries. A source step that packs several actions keeps its place as one numbered step that names the stage as an action ("Lock down the agent's tools"), with each of its actions an indented sub-step in sequence. Steps are never re-chunked, merged across the source's boundaries or regrouped to the model's taste. When the source gives no grouping, each action is its own numbered step.
- The steps run in the order the reader must do them. A step the source mentions late ("oh, I should have said, soak the stone first") moves to where it has to happen, and a step the source repeats appears once.
- Every check the source gives is kept: the test to run, the exact input to send, the result that means it passed, the sign that means it failed and what to do then. So is every condition it gives for doing the procedure again ("retest after every model change", "renew 30 days before expiry"). Each is a step, or sits in the step it belongs to, so the list ends where the source's procedure ends.
- Every warning, caution and failure sign the source gives sits inside the step it applies to, so the reader meets it before the action it guards.
- Quantities, temperatures, times, angles, settings, commands, file names and version numbers are kept exactly as the source gives them, and so are the literal values a step uses or checks against: example inputs, test strings and payloads, hostnames, addresses, URLs, ports, expected output and error messages. A command, path or literal value goes in inline code, character for character, never paraphrased ("send a test message") or swapped for a placeholder the source did not use. When the source marks a value as its own example ("I used", a fictional name, a sample path or account), the step tells the reader to use their own and gives the source's value beside it in inline code as the example.
- Talk around the procedure is left out: greetings, sponsor reads, requests to subscribe, anecdotes, digressions and opinions that change no action. Nothing is added around it either: no note, tip, troubleshooting direction, recommendation or editorial aside the source did not give, inside a step or after the list.
- Every step is specific to this input. A line that would fit most other tasks as well ("Gather your materials", "Be careful", "Practice makes perfect") fails.
- When the input is a source, every step, quantity and warning comes from it, read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs). For a bare topic or question, every step is one practitioners actually follow, and the safety-critical ones are in their safe order. Nothing is attributed to a named authority, and no figure appears that the model cannot stand behind.
- When the input teaches no procedure and none can be drawn from it, the output is the title and the single line `No instructions found in {the source}.`, and nothing else.
- The whole output is valid Markdown with no bold and no italics: the title, the sections and their lists.
- `bun skills/Fabric/Tools/ExtractInstructionsCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a clarifying question in place of the extraction. The model takes the default read and the title states it.
- Never a step, quantity, tool or warning the source did not give, and never a figure or command changed from the source's own.
- Never a step left where the source happened to mention it when the reader would have had to do it earlier.
- Never a safety step dropped, softened or moved after the action it guards.
- Never two actions merged into one step or one sub-step, and never one action split across steps to lengthen the list.
- Never the source's own steps or stages re-chunked, merged or regrouped; only a step the reader must do earlier moves.
- Never a test input, pass result, failure sign or repeat condition the source gave dropped or paraphrased.
- Never the actor of a step changed: no human approval turned into self-review, and no action moved from the system the source names onto the reader.
- Never a value the source calls its own example given as the one the reader must use.
- Never a note, tip, troubleshooting direction or closing remark the source did not give, inside a step or after the list.
- Never a reply that shows the instructions inside a shell command, a heredoc or a file-writing step, narrates a plan to draft or check them, prints checker output, or stops at an attempt to run a tool instead of delivering them.
- Never a description of what the source covers ("The video explains sharpening") in place of the steps themselves.
- Never a preamble, a persona, a rationale paragraph, a closing summary, or any text outside the title and the sections.
- Never a source read from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-extractinstructions — code checks on the title, the sections, the numbered steps, the kept figures and literal values and the no-instructions line, plus judged checks on step order, one action per step, the source's grouping, warnings and checks in place, fidelity to the source with nothing added, the hint override, the safe order for a bare task and specificity.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare task or topic, a how-to question, or "this"/"that" for the current conversation.
- An optional hint naming which part of the procedure, which method or which platform to keep, which overrides the default read.

## Tool contract

Run from `~/.claude`, with a shell tool, out of the reader's sight. Save the draft, check it, fix what it names, and deliver only on exit 0. None of this appears in the reply: the reply is the instructions alone. With no shell tool in the session, skip the command and check the rules in Output format by hand.

```bash
bun skills/Fabric/Tools/ExtractInstructionsCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any extraction) | `<file>` or `-` | Check the saved draft or stdin |
| (piping the result to another tool) | `--json` | Print `{ok, objectives, needs, steps, none, problems}` |

## Output format

Markdown: one H1 title, then the sections in this order, with nothing else. These are the limits the checker enforces:

- The title opens `# Instructions: ` and names the task and the read.
- `## Objectives` holds 1 to 10 `- ` bullets of 3 to 15 words, no two the same.
- `## You need` is optional; when present it holds at least one `- ` bullet.
- `## Instructions` holds a numbered list counting 1, 2, 3 with no gap, each step one line of at most 40 words, no two the same, none joining two actions with "then". Sub-steps are `- ` bullets indented under their step, at most 25 words each. A fenced code block may sit indented under a step.
- No other heading, no paragraph text, and no bold or italics anywhere (inline code is fine).

```markdown
# Instructions: {the task, and the source or read}

## Objectives

- {what following the steps achieves, at most 15 words}

## You need

- {material, tool or prerequisite, with the quantity or version given}

## Instructions

1. {first action, opening on its verb, with any warning that guards it}
2. {a stage the source names, as one action}
   - {its first action, done in sequence}
   - {its next action}
3. {next action, with the result that shows it worked}
```

With no procedure in the input:

```markdown
# Instructions: {the source}

No instructions found in {the source}.
```

## References

- Upstream: `Patterns/extract_instructions/system.md` (an "expert at extracting instructions" persona and a five-step process, producing an Objectives list of 3 to 10 bullets of about 15 words and a numbered Instructions list in the video's original order, with crucial warnings included; this intent keeps both sections and their limits, reads any input rather than only a video transcript, adds an optional You need section, keeps the list named Instructions and one action per step, keeps the source's own step grouping and every check and repeat condition it gives, and puts each step where the reader must do it rather than where the video said it).
- `Tools/ExtractInstructionsCheck.help.md`: the checker's rules and exit codes.
