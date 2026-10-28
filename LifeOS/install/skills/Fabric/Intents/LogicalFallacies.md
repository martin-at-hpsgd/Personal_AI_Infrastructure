# LogicalFallacies

The logical fallacies an argument actually commits, each named, typed, pinned to the exact words that commit it, and explained in one short line specific to this argument.

Our ideal-state port of Fabric's `find_logical_fallacies`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The list delivers what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (an article, post, speech, ad, transcript, email thread), a URL, a YouTube link or a file means the fallacies that source commits, read in full. A single argument typed on its own ("if we ban plastic straws, next they'll ban cars") means the fallacies in that argument. A bare topic ("astrology", "rent control") means the fallacies in the arguments people commonly make about it, from every side that makes them, each quoted in its common form. A question about an argument ("is 'everyone does it' a fallacy?") means that argument checked, and the list or the none line answers it. "This" or nothing means the arguments made in the current conversation, mine included. A typed hint ("only the formal ones", "just the second paragraph", "in my reply") overrides the default read and narrows the list to what it names.
- Every item is a fallacy the argument actually commits: a move in its reasoning, such as an attack on the person in place of the point, two options offered as the only ones, or a cause read off a sequence. A false fact, a strong word, an emotional tone or a conclusion I disagree with is not a fallacy unless the argument leans on it in place of a reason. A legitimate move (citing relevant expert consensus, questioning a source's demonstrated record, a supported causal chain) is not listed.
- Every fallacy the argument's main conclusions lean on is found. One sentence that makes two fallacious moves is two items; the same move made twice is one item, quoting its clearest instance. Items are ordered by how much of the argument rests on them.
- Each item names the most specific recognized fallacy that fits ("Tu quoque" over "Ad hominem", "Post hoc ergo propter hoc" over "Questionable cause") and gives its type, the family it belongs to, from the fixed list in § Output format.
- Each item quotes the exact words from the input that commit the fallacy, enough to find them and no more. For a bare topic the quote is the argument as people commonly put it, marked `Common form:`, never presented as a quote from a source.
- Each explanation is at most 15 words, says how this argument's reasoning fails at the quoted words, and is specific to this input: it would not fit the same fallacy in another argument.
- An argument whose reasoning holds gets the one `None found:` line saying why, never a list padded to look thorough.
- The same standard applies whichever side an argument favors.
- Words are plain and exact, the way a careful logic teacher would mark a student's essay.
- `bun skills/Fabric/Tools/LogicalFallaciesCheck.ts` passed on the exact output before it was delivered, with `--source` set to the input whenever the input was text or a file. Where no shell is available, the line shape, types, word counts and quotes are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a quote that is not the input's exact words, and never a common form passed off as something the source said.
- Never a fallacy listed that the argument does not commit, including a false or unsupported claim relabeled as a fallacy, or a legitimate appeal to relevant expertise called an appeal to authority.
- Never an explanation that says the conclusion is false because the argument is fallacious; a fallacy shows the reasoning fails, not that the conclusion does.
- Never a generic definition of the fallacy standing in for the explanation ("attacks the person instead of the argument").
- Never a source analyzed from its title or a fetched page summary instead of its full text.
- Never a request that is not a fallacy-finding job (what a straw man is, which patterns exist, how this works) turned into a fallacy list; it is answered directly.
- No bold or italic, and no preamble, persona, caveats or commentary outside the section.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-logicalfallacies — code checks on the section heading, the item line shape, the type list and the none line; judged checks on fallacies actually committed, quotes taken verbatim, explanations specific to the argument, sound reasoning left unflagged, and the definition question answered directly.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path, a single argument, a bare topic, a question about an argument, or "this"/nothing for the current conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the list.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/LogicalFallaciesCheck.ts <file|-> [--source <input-file>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any fallacy list) | `<file>` or `-` | Check the saved draft or stdin |
| (the input was pasted text or a file) | `--source <input-file>` | Also require every quote not marked `Common form:` to appear in the input |
| (piping the result to another tool) | `--json` | Print `{ok, none, fallacies, problems}` |

## Output format

```markdown
## Fallacies

- {Fallacy name}: {Type} — "{exact words from the input}" — {at most 15 words: how this reasoning fails there}
- {Fallacy name}: {Type} — Common form: "{the argument as people usually put it}" — {at most 15 words}
```

- Type is one of: Formal, Propositional, Quantification, Syllogistic, Informal, Improper premise, Faulty generalization, Questionable cause, Statistical, Relevance, Red herring. These are the families of the upstream catalogue; Informal covers the informal fallacies outside the named families (equivocation, false dilemma, slippery slope, moving the goalposts).
- The separators are em-dashes (`—`) with a space on each side. A quote shortened in the middle uses `…`, and each piece is still the input's exact words.
- Input whose reasoning holds, or that argues nothing, is the heading and the single line `None found: {at most 30 words on why the reasoning holds, or what the input is instead}`.
- Nothing else: no other heading, no summary line, no bold or italic.

## References

- Upstream: `Patterns/find_logical_fallacies/system.md` (an expert persona, a pasted Wikipedia catalogue of fallacies by family, and a FALLACIES section listing each as "Fallacy Name: Fallacy Type — 15 word explanation", with no bold or italic).
- `Tools/LogicalFallaciesCheck.help.md`: the checker's rules and exit codes.
- Neighbor: `Intents/AnalyzeClaims.md` when the request wants each claim's truth graded, with fallacies as one part of that.
