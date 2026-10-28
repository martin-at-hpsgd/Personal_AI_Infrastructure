# ExtractReferences

A clean, complete list of the works a piece of content points to (books, papers, studies, essays, articles, blog posts, films, shows, songs, art, poems, stories, fables, myths, talks), each named the way a reader can find it, with its creator, its kind and what the content uses it for, or the essential works on a topic when there is no content.

Our ideal-state port of Fabric's `extract_references`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

## Ideal State

- The list delivers what the principal wants from this input, inferred before writing and never asked for. A pasted artifact (an article, transcript, post, talk, notes), a URL, a YouTube link or a file means every work that source refers to, read in full, whether it names the work or only points at it. A bare topic ("stoicism", "game theory") means the essential works on it, the ones an expert in the field would put on a newcomer's list, with each note saying what the work is the reference for. A question ("what should I read to understand inflation?") means the works that answer it. "This" or nothing means the works mentioned in the current conversation, mine included. Input that refers to no work at all (a recipe, a status update) means the one `**No references:**` line. A typed hint ("just the books", "only the papers", "top 5", "all of them", "under 10 words each") overrides the default read and narrows the list, changes its length or shortens its bullets to what it names. Only a restricting word ("just", "only", "no films", "leave out") narrows by kind. A request that names kinds in passing while asking for the whole set ("all the books and papers this leans on, I want to credit everything", "what sources does it use") narrows nothing, and neither does a framing that names no kind ("a reading list from this", "what does it cite"): every work the content points to is listed, fables, films and stories included, because the reader's purpose (crediting, reading, checking) needs all of them.
- The heading names the read that was inferred ("References in the offsite notes", "Essential references: stoicism", "References for: understanding inflation"), so a wrong read is visible at a glance. A heading never names a narrower set of kinds than the list holds.
- The list is complete. Every work the content points to is on it, whatever kinds the request happened to name, or counted in the `**Left out:**` line, including the easy-to-miss ones: a fable, myth, parable or folk tale told by its plot or its moral, a scripture passage, a song quoted in passing, and a specific post, article, thread or video given only as a link. Before delivering, the source is read once more from the top, and each work it points to is found on the list.
- Every bullet is one specific work or body of work: a book, paper, study, article, blog post, essay, report, film, show, documentary, song, album, painting, poem, play, story, fable, myth, scripture, talk, lecture, podcast, video or game. A body of work counts when the content points at the work ("Rilke's poetry"). A specific page the content links to or cites (a post, an article, a report, a writeup) is a work. A person mentioned without any work of theirs, a company, a product, an app, or a site named only as a place ("we keep notes in Notion", "I read it on Medium") is not a reference and is left out.
- Each work is named the way the content names it, corrected only for spelling and punctuation (`Moby Dick` becomes `Moby-Dick`). A work the content calls by a short or informal name keeps that name; it is never expanded into a formal title, subtitle, venue or year the content does not give. A work the content names by its creator and subject rather than a title ("the Anthropic paper on agentic misalignment", "Aesop's fable of the scorpion and the frog") is already findable as given: its bullet keeps that description as its name, never a title made up from it.
- A detail the content gives that helps a reader find or credit the work (its year, the chapter it draws on, the content's doubt about it: "or was it 7231", "maybe a paper behind it") goes in the note in a few words. A detail the content does not give is never added.
- A vague label the same content pins down ("the mitre doc" beside an ATT&CK technique ID, "that RFC" beside its number) is the work the content makes plain, named from the content's own words, never listed as unidentified.
- A work the content points at without naming it at all ("the novel about the man hunting the white whale", "the fable where the slow animal wins the race") is identified when its description fits one work beyond doubt, given that work's common title, and marked `alluded` in its kind, so a reader can tell it apart from a work the content names.
- A work the content points at too loosely to identify for certain ("a book someone recommended on burnout", "that paper from last year on caching") is still listed, under the content's own description of it, with no creator and `unidentified` in its kind. A guessed title never takes its place, and a likely candidate is never named, in the bullet or anywhere else.
- When the content gives a URL for a work, the bullet ends with that URL exactly as given, in angle brackets, so the reader can open the work. When the content gives the URL and no title, the URL stands in the title's place and is not repeated at the end. A URL the content does not give is never added.
- Each work's creator is the real one. When the content credits the wrong person, the bullet gives the right creator and its note says whom the content credited. A creator the content does not name is added only when the work is identified beyond doubt and its creator is not in question; a fable keeps its traditional attribution (Aesop), and a creator who is genuinely unknown (an anonymous myth, a folk tale) is left off rather than guessed. A work with more than two creators gives the first and "et al." so the bullet stays short.
- Each note says, in a few words (usually three to seven, never more than 12), what this content uses the work for (the point it supports, the scene it sets, the argument it borrows), specific to this input and drawn only from it. For a bare topic or a question, the note says what the work is the reference for. A note that would fit any mention of the work ("a classic book") fails, and so does one that brings in facts about the work the content never states. The note never repeats what the title, creator or kind already show.
- Each bullet holds at most 16 words in all, title, creator, kind, note and URL counted together (a URL is one word), or the length a hint asks for; most bullets land well under it, around 8 to 12 words, so the list scans like a bibliography. A long title is cited by its main title, before any subtitle, and the note gets shorter to fit.
- Each work appears once, however often the content mentions it. Bullets follow the order the works first appear in the content; for a bare topic, the most foundational work comes first.
- The list holds at most 20 works, or the number a hint asks for. When the content refers to more, the works it leans on most are kept and one closing line says how many passing references were left out.
- Words are plain and exact, the way a careful librarian would list sources for a colleague.
- `bun skills/Fabric/Tools/ExtractReferencesCheck.ts` passed on the exact output before it was delivered, with `--source` set to the input whenever the input was text or a file, `--max` set to any count a hint asked for, and `--words` set to any bullet length a hint asked for. Where no shell is available, the shape, counts and titles are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a work the content does not refer to, added because it is related, famous or usually cited beside the ones it does mention.
- Never a work the content does refer to left off the list and out of the `**Left out:**` count, least of all a fable, myth or story it tells without naming, a page it gives only as a link, or a work dropped because the request named other kinds without restricting the list to them.
- Never a guessed title for a work the content leaves unidentified, whether as the bullet's title or as a "possibly" or "likely" beside it.
- Never a work that does not exist, and never a real work credited to the wrong creator, including repeating the content's own misattribution as fact.
- Never a person, company, product or tool listed as if it were a work.
- Never a work listed twice, and never two separate works merged into one bullet.
- Never a source's references taken from its title, abstract or a fetched page summary instead of its full text.
- Never a year, edition, venue, page number, subtitle or formal title added that the content does not give; a guessed date is a wrong date.
- Never a URL the content gives dropped from its work's bullet, or a URL the content does not give added to one.
- Never a bullet over 16 words in all, or over the length a hint asked for.
- No preamble, persona, caveats or commentary outside the heading, the bullets and the one closing line.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-extractreferences — code checks on the heading, the bullet shape, the cap and the no-references line; judged checks on references kept to what the content actually refers to, every referred-to work present (an untitled fable included), misattributions corrected, people and products left out, allusions identified, unidentified works kept as described with no guessed title, given URLs kept, and notes specific to the input.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted text, a URL, a YouTube link, a file path, a bare topic, a question, or "this"/nothing for the current conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the kinds of work or setting the count.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/ExtractReferencesCheck.ts <file|-> [--source <input-file>] [--max N] [--words N] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (any list) | `<file>` or `-` | Check the saved draft or stdin |
| (the input was pasted text or a file) | `--source <input-file>` | Also require every bullet not marked `alluded` or `unidentified` to have its title, before any subtitle, appear in the input, and every URL to appear in it exactly |
| "top 5", "just three" | `--max 5` | Cap the bullets at the hinted count instead of 20 |
| "all of them" | `--max 0` | No cap |
| "under 10 words each" | `--words 10` | Cap each whole bullet at the hinted length instead of 16 |
| (piping the result to another tool) | `--json` | Print `{ok, noReferences, heading, references, leftOut, problems}` |

## Output format

```markdown
**{the inferred read, e.g. References in the offsite notes}**

- *{Title}*, {Creator} ({kind}): {what the content uses it for, at most 12 words}
- *{Title}* ({kind}, alluded): {note}
- *{the content's own description of it}* ({kind}, unidentified): {note}
- *{Title}*, {Creator} ({kind}): {note} <{URL as given}>
- *{URL as given, when the content gives no title}* ({kind}): {note}
…

**Left out:** {N} more passing references.
```

- The creator and its comma are dropped when the creator is unknown, and always for an `unidentified` work.
- The kind is one to three plain words (`novel`, `paper`, `film`, `fable`, `blog post`), followed by `, alluded` when the content does not give the title but the work is identified, or `, unidentified` when it cannot be.
- The `<URL>` closes the bullet only when the content gives one for that work.
- Each bullet holds at most 16 words in all, title and URL included; a long title is cited by its main title before any subtitle.
- The `**Left out:**` line appears only when works were dropped to meet the cap.
- Input that refers to no work is the single line `**No references:** {what the input is instead}`.

## References

- Upstream: `Patterns/extract_references/system.md` (a bulleted list of up to 20 references to art, stories, books, literature, papers and other sources of learning, each bullet at most 16 words). We hold the same 16-word bullet, counted over the whole bullet.
- `Tools/ExtractReferencesCheck.help.md`: the checker's rules and exit codes.
- Neighbor: `Intents/ExtractRecommendations.md` when the request wants the advice a source gives rather than the works it cites.
