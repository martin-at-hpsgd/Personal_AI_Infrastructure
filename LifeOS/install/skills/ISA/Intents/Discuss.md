# Discuss Intent

The standing alignment conversation of every ISA. Whenever what done means is uncertain, Discuss draws the answer out of the principal in short rounds, each question carrying my recommended answer, and folds every answer into the ladder and the criteria the same turn. It runs before an ISA exists, while one is being climbed, and whenever one wobbles.

## Ideal State

- **Discuss runs whenever the ISA's state says direction is uncertain, not when I happen to remember it.** `bun LIFEOS/TOOLS/IsaAlign.ts status <isa>` reads that state (no ladder, a restate the principal corrected that was never re-aligned, open asks piling up, thick fog) and returns `DISCUSS` with the entry state and the reasons, or `ALIGNED`. A `DISCUSS` verdict means a round runs before more is built on the uncertain part. Any doubt the tool cannot see also earns a round: a correction from the principal that changes the destination, a drift verdict of `partial` or `divergent`, a Rate verdict of DISCUSS-FIRST, the principal thinking out loud ("I'm not sure", "something like", "what do you think") on substantial work, or my own honest answer of "maybe" to "could I be wrong about what done means?"
- **The entry state fits where the ISA is.** `discover` when there is no ISA or no ladder yet: the idea is drawn out until its shape is clear, then handed to Scaffold. `align` when an ISA exists and its direction is in question: the round opens on the ladder as it stands and asks only about the uncertainty. `deepen` when the ladder holds but sections are thin or fog is thick: the round fills them, the way Interview does, through the same engine.
- **The depth fits the uncertainty, so a round is cheap enough to run every time it is owed.** `quick` is one round that asks the whole current frontier at once (usually four questions or fewer, one AskUserQuestion call, about a minute of the principal's time) and is the default for `align`. `full` runs rounds until the frontier is empty and is the default for `discover`. `deep` spans sessions with a coverage map of the domain, for an ideal state too large for one sitting (a platform, a program, a campaign, a life area); each session picks up the open frontier. The status tool never picks `deep`: I choose it when the ideal state is that large, or the principal does.
- **Every round follows the shared engine** `../References/Discussion.md`: the ladder shown first in `align` and `deepen`, the whole askable frontier asked at once, my recommended answer leading every question, at least one question that pushes on the weakest assumption, facts looked up rather than asked, and a one-line say-back of what changed once the round is folded.
- **The record is complete and the ladder is current after every round.** Each round is checkpointed into the ISA's `## Articulation Log` through `IsaAlign.ts checkpoint` (one dated `· discuss — <topic>` block per session, rounds appended while it is the log's last block, headings demoted, earlier bytes untouched), and the same turn the answers reach the ladder (L1 rewritten where it changed, L2 and L3 re-derived), the criteria (added, split, tightened or killed with a `refined:` Decisions row), `## Not yet specified`, and `## Language` when a term had to be negotiated. A session the principal abandons still leaves its partial record and where it paused.
- **When the shape was unclear** (a skill, a hook, a CLI, a doc, a product), it was pruned to one of two or three proposed candidates before the tree was walked.
- **Before a `discover` or `full` session closes,** a failure-mode pass ("imagine this shipped and failed; what went wrong?") turned each answer into a draft binary criterion, which is what makes the resulting ISA hard to vary.
- **The session ends on direction.** When L3 or L2 changed, the closing message is the Restate shape (L3 and L2 verbatim, then "is that right?"), and a no is folded and shown again. When the round only sharpened criteria, the say-back is enough.
- **`discover` hands Scaffold a ladder,** plus the draft criteria, targeting the same ISA file; every open flag lands in that ISA, precisely statable ones as criteria, dim ones in `## Not yet specified`, follow-ups in `## Remaining Work`.
- **Use is measured.** `IsaAlign.ts stats` counts Discuss, Restate and ask activity across every ISA and how many ISAs currently owe a round, so the system can see whether the loop is actually running.

## Anti-criteria

- Never manufactures questions for an ISA whose direction is settled: `ALIGNED` with no doubt in the conversation means no round, and a well-formed new topic routes straight to Scaffold.
- Never asks what the record could answer (code, files, deploy state, a prior ISA, a tool); that is a lookup.
- Never runs a `full` session where a `quick` round would settle the doubt, and never stops a `discover` session at one round while the frontier is still open.
- Never blocks unblocked criteria from climbing while a round is pending, and never builds the uncertain part on a guess once a round is owed. The principal's `proceed` or "just build it" overrides, logged as a dated `## Decisions` row naming `discuss skipped` and the defaults taken, which the status tool reads.
- Never puts an open flag in an external task list.
- Never writes a standalone `discussion.md` for a new run, and no line inside a log block starts with `#`.
- Never creates a new ISA project-relative: a new one lives at the absolute `~/.claude/LIFEOS/MEMORY/WORK/{slug}/ISA.md` even when invoked from another repo's cwd.

## Inputs

### When to invoke

- **`IsaAlign.ts status` says `DISCUSS`.** The AlgorithmNudge hook names an owed `align` or `deepen` round when an ISA edit lands (its articulation row covers a missing ladder); check the status yourself before building on an ISA you did not write this session.
- **Restate got anything other than a clean yes** and the correction changes the destination (Restate § Anti-criteria hands it here).
- **Refine's queue clusters:** an answer that would change L3 or L2, or two or more open asks blocking the same Feature or the same criterion (Refine hands them here as one `align` round, and their answers are recorded against each fence through `IsaAsks.ts answer`, never a second time through `checkpoint`).
- **Rate returned DISCUSS-FIRST,** or the drift check returned `partial` or `divergent`.
- **The ideal state lives only in the principal's head** (generative, experiential, strategic or new-product work with no record to read): `discover`, before Scaffold writes more than the ladder.
- **The principal asks:** `/discuss <topic>`, `Skill("ISA", "discuss <topic-or-isa>")`, "let's discuss", "talk it through", "help me figure out the shape", "are we aligned?".
- **To refresh an ISA with new findings:** "discuss <slug> again, here's what changed."

| Input | Required | Description |
|-------|----------|--------------|
| topic or ISA | yes | The idea to draw out, or the ISA (path or slug) to align |
| mode | no | `discover`, `align` or `deepen`; taken from `IsaAlign.ts status` when absent, and when the status is `ALIGNED` (the doubt came from Rate, drift or the conversation), `align` when a ladder exists, otherwise `discover` |
| depth | no | `quick`, `full` or `deep`; `quick` for `align`, `full` for `discover` and `deepen` when absent |
| slug | no | WORK dir for a new ISA; derived from the topic when absent |

## Tool contract

Run from `~/.claude`.

```bash
bun LIFEOS/TOOLS/IsaAlign.ts status <isa> [--json]                  # ALIGNED | DISCUSS, with mode, depth and reasons
bun LIFEOS/TOOLS/IsaAlign.ts checkpoint <isa> --topic "<topic>" --mode <discover|align|deepen> --text "<round>"   # or --file <path>
bun LIFEOS/TOOLS/IsaAlign.ts stats [--since YYYY-MM-DD] [--json]     # use across every ISA
bun LIFEOS/TOOLS/IsaLadder.ts check <isa>                           # ladder shape after folding
bun LIFEOS/TOOLS/IsaLadder.ts drift <isa>                           # criteria still add up to L3
```

`checkpoint` creates the minimal ISA (frontmatter with `phase: marking`, H1, an empty `## Articulation Log`) when the path does not exist and `--create` is passed, appends to this session's block when the last block is today's discuss block on the same topic, and otherwise opens a new block. It demotes any line starting with `#` inside the round, and refuses to write when the log is not the last section.

At the terminal a round is one AskUserQuestion call (chain a second call when the frontier holds more than four questions), recommended option first and marked "(Recommended)". On a texting or headless channel the round is sent as text, the default builds meanwhile, and the block records `pending`.

`discover` hands off with `Skill("ISA", "scaffold from prompt: <the Ideal State ladder + draft criteria>")`, targeting the same ISA file: Scaffold extends it, keeps the ladder and the log, and preserves the stated goal in frontmatter.

## Gotchas

- **Optional means never.** Until v8.41.0 the doctrine left Discuss to my discretion and never required it, and in 1,205 ISAs it ran once (2026-09-05) while 16 Restates and 3 asks ran. A conversation that waits for me to decide it is worth the principal's time does not happen; the state check exists so the decision is the ISA's, and the `quick` depth exists so the cost is a minute.
- **Principal abandons mid-discussion:** the partial log block is still valuable; note where it paused at the end of the block. The next Discuss run appends a fresh block and picks up the open frontier.
- **An `align` round is not a Restate.** Restate asks one yes-or-no about the ladder. When the answer opens questions, Restate stops and Discuss asks them; never stretch a Restate into an interview.

## References

- `../References/Discussion.md`: the shared engine (frontier rounds, recommendations, the challenge question, the say-back, checkpointing).
- `Restate.md`: the closing check when a round changed L3 or L2.
- `Interview.md`: section-by-section filling; `deepen` follows its order when sections are thin.
- `Refine.md`: single decisions mid-climb, which escalate here when they cluster.
