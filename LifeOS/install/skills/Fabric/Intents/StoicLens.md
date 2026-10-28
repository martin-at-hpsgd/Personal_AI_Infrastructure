# StoicLens

A philosophical reading of a text through the history of ideas: the traditions and thinkers it draws on, named or not, where it departs from them, the questions a Stoic and other rigorous philosophers would ask that it leaves unasked, who else works its ground, and the threads worth pulling next.

Our ideal-state port of Fabric's `lens_stoic`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Gotchas · Output format · References

## Ideal State

- The reading delivers what the principal wants from this input, inferred before writing and never asked for. A pasted text, a URL, a YouTube link or a file means where that exact text's ideas come from and what it assumes, with every finding pointed to the moment in its words. A bare named work ("the Serenity Prayer", "Walden") means that work as published, with the version read named in a `**Source:**` line. A bare idea, movement or slogan ("effective altruism", "hustle culture") means the idea as its main proponents state it, with `**Source:**` naming it as a composite of those statements. A question about a text ("is this just repackaged Stoicism?", "where does this come from?") gets the full reading with its direct answer in an `**Answer:**` line under the title, and the answer follows the evidence even when it is no. "This" or nothing means the draft, post or argument under discussion in the conversation, often the principal's own writing he wants to see more clearly. A text that carries no idea or argument to trace (a timetable, a recipe, a log) gets the single line `**Nothing to trace:**` saying what the text is instead. A typed hint that restricts ("just the lineage", "only what a Stoic would ask") overrides the default and narrows the output to the sections it names, in the same format and order. A request that lists what it wants ("I want lineage, tensions, and what I haven't asked", "what am I missing") is emphasis, never a restriction: it gets the full five-section reading, with the named parts worked hardest.
- The reading analyzes where the text comes from and what it assumes. It never summarizes what the text says, and it never rules on whether the text is right.
- Philosophical lineage names the specific thinker, school or text behind each idea, the specific parallel, and whether the text itself names that source or leaves it unnamed. The unnamed sources are found, not only the ones the author cites. When a text was supplied, each lineage entry points to the words that carry the idea, quoted exactly.
- Lineage is the history of ideas: the philosophers, political and moral theorists and schools (ancient to contemporary) whose arguments the text's moves repeat, such as Aristotle's practical wisdom, Kant on self-incurred immaturity, Tocqueville's soft despotism, Arendt on irreversible action. A management book, an engineering principle or a self-help framework may be named as the channel an idea arrived through, but it never stands in for the philosophical source behind it, and most entries are philosophers. When a text clearly works one tradition, the reading traces it to that tradition's principal figures (for Stoicism, Epictetus, Seneca and Marcus Aurelius), not to one of them.
- Each lineage entry says how close the link is, and its strength matches the evidence in both directions. When the text's words reproduce a tradition's signature move specifically (a two-pile sort by what is up to us, Epictetus's own list of reputation and office as not ours), the reading says so plainly ("the draft is Stoic at its core, and the source is unnamed"), because hedging a clear descent into a resonance is as wrong as inventing one. A short fragment rarely proves a descent, so a thin text gets its parallels framed as resonances ("reads like", "close to"), never a definite lineage ("this is Platonic") its few words cannot carry, and the reading says plainly when a line could come from several traditions.
- The reading works the text's own distinctive claims, the move it makes that is its own (a claim tying the market to the mind, a rule about when rest is allowed), rather than the broad theme around them. Tensions and unasked questions draw the distinctions the text's concepts need, such as handing a task over versus losing the power to take it back, depending on something versus being unable to revoke it, approving a result versus checking it. When something in the text has several plausible causes, the reading keeps them plural instead of reducing it to the one it finds most familiar.
- Stoicism is read as the whole school taught it, not only the dichotomy of control. Before a reading calls a line a departure from Stoicism, it checks the line against the rest of Stoic teaching: practiced voluntary hardship and rehearsal of poverty (Seneca, *Letters* 18; Musonius Rufus on training), rehearsing misfortune in advance (*premeditatio malorum*), preferred and dispreferred indifferents, the duty to others and to the common good (*oikeiosis*, cosmopolitanism), and the Stoic acceptance of grief's first movements. A text that matches a less famous Stoic teaching follows Stoicism there, and the reading says so. Stoic moral psychology is stated as the Stoics held it: impressions and first movements arise unbidden and only assent is up to us, so attention itself is a partly voluntary, trained capacity, and a text that decrees "zero attention" to something is claiming more control than the Stoics granted, never a match for their teaching on assent.
- Key tensions and divergences finds where the text departs from, transforms or contradicts its own sources, names the source it departs from and what the source held instead, and quotes the moment in the text where the tension appears. It also finds the strains inside the text's own argument: a remedy that works at a different level than the diagnosis (a single-step rule against an aggregate drift), a bright-line rule beside a call for case-by-case judgment, a central concept that fails the text's own test, two senses of one word run together. Each distinct tension is its own short paragraph opening on a bold name for it (`**Rule versus judgment.**`), so the reader sees how many there are. When the text follows its sources faithfully, the section says so rather than inventing a break.
- Unasked questions are the questions a rigorous philosopher would put to this text that it does not address, each attributed to the tradition or thinker who would ask it and phrased as a question. A Stoic question is always among them, since the lens carries the Stoic name, but the others range across the traditions the text most needs to hear from, ethical, political and social as well as Stoic (who is "we" when adoption is a collective pressure, whether a human checkpoint is real control or a place to put blame). Each question is concrete enough that the author could answer it in a revision, and may carry one sentence of setup before it. They mark the horizon the author chose not to cross; they are not complaints.
- Connections to other thinkers names the people, schools or texts that work the same territory, each with the work that does it, says whether each converges with or contradicts the text, and says why the connection matters for this text. It includes the contemporary writers working the text's own subject (the current literature on AI risk for an AI piece, the attention-economy critics for a piece on attention) beside the older philosophers. A connection already given as lineage is not repeated here.
- Synthesis seeds are threads a reader could pull: ideas the reading surfaced that the text did not fully articulate, each opening on a short bold name and developed in two or three sentences into a distinction, reframing or test the author could build on. When the text is the principal's own draft, the seeds are the revisions the reading points to, such as the new category, the second axis or the experiment that would make the piece stronger.
- Every attribution is accurate. A thinker is credited only with a view they held, a work is named by its real title, and a quotation from a thinker is their actual wording or is given as a paraphrase without quotation marks. A thinker is quoted in quotation marks only when the exact wording and its place (book and section, letter number) are certain; anything less is a paraphrase that names the work, and no section or seed closes on a famous line used as a flourish.
- Every finding is specific to this text: a line that would read as well under a different text ("draws on Western philosophy", "raises questions about meaning") fails.
- Every claim about a field outside philosophy (security engineering, finance, psychology, law) is accurate too: a principle is credited only with what it actually does, and a reading never rests a tension on a technical claim it has not got right.
- Depth follows what the text carries, not its word count. A thin fragment or slogan gets two or three entries a section. A paragraph that makes several distinct moves (a diagnosis, a rule, an example, a closing maxim) carries a full reading, usually four to six entries a section, each developed past a single sentence, because each move has its own lineage and its own strain. A section with little to say says it in a sentence, never padding.
- Words are plain and exact, with philosophical terms (the dichotomy of control, eudaimonia, ataraxia) used where they are the precise word and glossed by what they mean.
- Sources are read in full before any reading (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- `bun skills/Fabric/Tools/StoicLensCheck.ts` passed on the exact output before it was delivered, with `--source` pointing at the supplied text whenever there was one. Where no shell is available, the sections and quotations are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a quotation presented as the text's words that does not appear in the supplied text, and never a named work quoted from memory with wording that is not its own.
- Never a thinker credited with a view they did not hold, or a famous line pinned on someone who did not write it.
- Never Stoicism forced onto a text whose lineage lies elsewhere; when the source is Epicurean, Buddhist or pragmatist, the reading says so.
- Never a section that restates the text's argument instead of tracing where it comes from.
- Never a manufactured tension, question or connection to fill a section the text does not support.
- Never a definite lineage asserted for a fragment whose words support only a resonance, and never one tradition chosen as the source when the words fit several equally.
- Never a text called un-Stoic on the strength of one Stoic doctrine when another Stoic teaching endorses what it says.
- Never a clear, specific descent hedged into a mere resonance, and never a lineage built mostly from management, engineering or self-help sources where philosophers did the thinking first.
- Never a reading narrowed to some sections because the request listed what it cared about; only an explicit "just" or "only" narrows.
- Never a phenomenon in the text reduced to a single cause, with confidence, when the text and its sources leave several open.
- Never a quotation of a thinker offered as the accurate or corrected wording unless that wording is certain; an uncertain line is paraphrased, and a hedge such as "that wording should be checked" never travels with quotation marks, because a line that needs checking is a paraphrase.
- Never a verdict on whether the text's position is correct.
- Never a filled-in reading of a text that carries no idea to trace.
- Never a source read from its title or a fetched page summary instead of its full text.
- No preamble, warnings, notes or commentary outside the sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-stoiclens — code checks on the title, the five sections in order, the Source, Answer and nothing-to-trace lines, the named or unnamed lineage marks, attributed questions with a Stoic one among them, and connection marks; judged checks on reading over summary, unnamed sources found, quotations faithful to the text, accurate attributions, tensions at the right moment, and no Stoicism forced onto a text that is not Stoic.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The text: pasted, a URL, a YouTube link, a file path, a bare named work, a bare idea or movement, a question about a text, or "this"/nothing for the conversation's subject.
- An optional hint narrowing the reading to named sections.

## Tool contract

Run from `~/.claude`. Save the draft (and the supplied text, when there is one), check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/StoicLensCheck.ts <file|-> [--source <text-file>] [--sections <list>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any full reading) | `<file>` or `-` | Check the saved draft or stdin |
| (a text was supplied) | `--source <text-file>` | Each lineage entry and the tensions section must quote the text, with at least one quotation in each found in it word for word, and no quotation may be a near miss of its wording |
| "just the lineage", "what would a Stoic ask" | `--sections lineage` or `--sections questions` | Expect only the named sections, in canonical order |
| (piping the result to another tool) | `--json` | Print `{ok, nothingToTrace, sections, problems}` |

## Gotchas

- Quotations woven into a sentence drift from the text's wording to fit the grammar around them: in the 2026-10-25 suite run the post's "feels it fastest" came out as "feel it fastest". The `--source` check fails any quotation that is a near miss of the text, so the fix is to quote the exact words and rephrase the sentence around them.
- On a thin fragment the pull is to give it a pedigree: in the 2026-10-25 head-to-head both readings named a definite Platonic or Stoic descent for a few lines that only resembled them, and one called voluntary discomfort un-Stoic, which the *Letters* of Seneca (18) and Musonius Rufus contradict. Grade each link (source, likely influence, resonance) and check a claimed departure against the whole school before writing it.
- On a substantive passage the pull runs the other way: in the second 2026-10-25 head-to-head the port lost twice to a reading that named more philosophers and drew more distinctions. It had treated "lineage, tensions, and what I haven't asked" as a hint and dropped two sections, hedged a plainly Stoic draft into "likely influence", filled lineage with Covey, Bezos and a security paper, called "zero further attention" the Stoic teaching on first movements when the Stoics held attention only partly voluntary, and misstated what complete mediation checks. Calibrate confidence to the evidence both ways, keep lineage philosophical, and check technical claims.
- Closing on a remembered line from Marcus Aurelius or Seneca is where invented quotations slip in. Paraphrase with the work named unless the wording is certain.

## Output format

`**Source:**` appears only when no text was supplied; `**Answer:**` only when the request asked a question. Key tensions and divergences is prose; the other four sections are bullets.

```markdown
# Stoic Lens: {what the text is, in a few words}

**Source:** {the version read, or "Composite of {the statements it draws on}"}

**Answer:** {the direct answer to the question asked}

## Philosophical lineage

- **{Thinker, school or text}** ({named | unnamed}): "{the text's words that carry the idea}" {the specific parallel, and how close it is: a source, a likely influence or a resonance}

## Key tensions and divergences

**{Name of the tension}.** {where the text departs from its sources or strains against itself, naming the source and what it held, and quoting the moment the tension appears}

**{Name of the next tension}.** {one paragraph per distinct tension}

## Unasked questions

- **{Stoic thinker or the Stoics}:** {the question}?
- **{Tradition or thinker}:** {the question}?

## Connections to other thinkers

- **{Thinker, school or text}** ({converges | contradicts | converges and contradicts}): {why the connection matters for this text}

## Synthesis seeds

- **{Short name}.** {a thread worth pulling, developed into the distinction, reframing or test it would build}
```

A hint-narrowed reading keeps the title and only the sections the hint names, in the order above. A text with nothing to trace is the single line `**Nothing to trace:** {what the text is instead}`.

## References

- Upstream: `Patterns/lens_stoic/system.md` (a history-of-ideas reading in five sections: philosophical lineage, key tensions and divergences, unasked questions, connections to other thinkers and synthesis seeds, specific to the text and calibrated to its length).
- `Tools/StoicLensCheck.help.md`: the checker's rules and exit codes.
