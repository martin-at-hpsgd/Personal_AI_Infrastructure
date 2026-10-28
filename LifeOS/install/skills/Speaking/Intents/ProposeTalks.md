# ProposeTalks

Talk and panel proposals the speaker can send straight to a conference organizer, built from their goals, positions, interests and the target event.

## Ideal State

- The proposal is the output of `Patterns/recommend_talkpanel_topics/system.md` run over the speaker's goals, positions and interests plus the target event (when one is named): a TALKS section with three talk titles and abstracts, and a PANELS section with three panel topics, each carrying the points the speaker would raise and proposed panel questions.
- Every talk and panel fits a topic under `## Topics` in Config.md (SKILL.md § Data & Config), and when a target event is named, each one names why it fits that event's audience or theme.
- The text is ready to paste to an organizer: valid Markdown with no asterisks, no placeholders such as `$name of person$` or blanks left unfilled, and written in the third person about the speaker, by name.

## Anti-criteria

- No generic talk that could come from any speaker: each title and abstract rests on a position or piece of work that is the speaker's own, from `## Signature talking points` or the sources named under `## Speaker record` in Config.md.
- No invented credentials, past talks, or affiliations; a claim about the speaker's record comes from a source named under `## Speaker record`.
- Never sent to an organizer from this intent: it produces the draft only.

## Inputs

- Config.md `## Speaker record`: where the speaker's goals and interests, published positions, and sourced credentials live (files, a TELOS, other skills or URLs).
- Config.md `## Signature talking points`: positions the speaker has already worked out, usable as talk or panel material.
- The target event, when named: its entry in the opportunities list (SKILL.md § Data & Config) or its CFP page.
- `Patterns/recommend_talkpanel_topics/system.md`: the system prompt that shapes the output.

## References

- `ShowOpportunities`: which events are worth a proposal right now.
