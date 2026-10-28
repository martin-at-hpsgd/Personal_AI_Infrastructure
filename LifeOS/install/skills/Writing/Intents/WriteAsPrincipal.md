# WriteAsPrincipal

Author or repair long-form prose in the principal's voice, against a corpus-derived model rather than a list of things to avoid.

## Ideal State

- **It reads like the exemplars, and most of all like the anchor.** Someone who reads the principal regularly would believe they wrote it. The rule in one line: the corpus median is the floor for "not collapsed", the anchor's own value is the target. On the metrics where the anchor sits above the corpus median (first person, hedging and sentence spread are the usual ones), lean toward the anchor's value; that is no license to run high on a metric where the anchor does not.
- **`VoiceGate.ts` exits 0.** No forbidden construction, no house-style violation, and fewer than three core voice metrics collapsed.
- **`VoiceJudge.ts` exits 0.** Every dimension (six by default) clears threshold, not just the weighted average.
- **The principal is in the piece** — their own history with the idea, what they think, what they are unsure about, what they find exciting.
- **Sentences reach.** The explanatory sentences run long, to the config's `sentence_reach_words` range when set (else the reach `VoiceProfile.md` shows), and carry the argument; short ones land after them as payoffs.
- **Nothing about the content changed.** Every fact, date, quote, citation and link survives a repair unaltered.
- **The audit line is real.** This skill's `detect` mode plus a genuine `PangramScore.ts` run before anything is published. Pangram is reported, never a gate — it saturates near 100% on all model prose, including the corpus.
- The draft is built on the whole anchor piece (`${corpus_root}/${anchor}.md`), the `Exemplars.md` passages, and the config's `## Install notes` (when present): a reviewer can point to the anchor and exemplar moves it uses, and it breaks no install note.
- When `corpus_cli` is set in the skill config, the principal's published position was checked before the first sentence: `status` (its last-sync date noted in the draft notes if it predates content that would move the stance), `opinion "<topic>"`, and the pieces from `post "<topic>" 5` read whole before writing. When it is unset, the draft notes say the published-position check was skipped, and stances come only from the brief, the corpus pieces and the principal.
- A draft anchors in a position the principal has published when one exists (an "I have been saying X since <year>" opener is theirs only when the record shows it), surfaces a contradiction with an older position instead of smoothing it, and never attributes a stance the record cannot back with a quote.

## Anti-criteria

- **Never degrade prose to pass a check.** No injected typos, no broken grammar, no "humanizer" laundering. A draft that passes by damage has failed. The goal is the principal's voice and quality, never text that passes as human; when it must carry the principal's own judgment, the lever is the principal in the loop.
- **Zero of the constructions the config holds at zero** (`hard_zero`; by default the negation family, such as "it's not X, it's Y"), including in a repair of the principal's own older writing. If the corpus predates a ban it still contains them; new drafts may not.
- **House style followed** (`house_style_only`; by default em dashes are closed, `word—word`). An install that drops `spaced-em-dash` from that list keeps its spaced dashes.
- **Quoted material is never edited.** Other people's words keep their negations and their punctuation.
- **A repair changes voice, never claims.**
- **Never invent a person.** No fabricated first-person anecdote, memory, conversation, or opinion for the principal. If the draft needs a story the brief or corpus does not supply, leave a `[NEEDS: anecdote about X]` marker for the principal to fill.

## Inputs

Resolved under `${VOICE_DIR}` = `voice_dir` in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/Config.md` (`bun Tools/WritingConfig.ts status` prints it).

| File | What it is |
|---|---|
| `Corpus.md` | The long-form pieces the principal wrote themselves, with the selection rule, the exclusions with reasons, `corpus_root` in its frontmatter (where the source files live), and `anchor:` — the one piece they nominated as the prose they like best of their own |
| `VoiceProfile.md` | The positive model — the moves the prose makes, each with a measured number or a cited passage; § The anchor piece holds the moves read off the anchor alone |
| `Exemplars.md` | Verbatim passages tagged by move. Load these; they outperform any description. § Anchor is the target section |
| `PostExemplars.md` | The principal's real short posts, verbatim. The target for SHORT-FORM work (`VoiceJudge.ts --short`), needed only for it; never the essay model for a post |
| `VoiceProfile.json` | Measured p10/p50/p90 bands, `hard_zero` (doctrine bans that outrank the corpus), `house_style_only`, and the anchor's own vector under `anchor`; written by `BuildVoiceProfile.ts` |
| `${corpus_root}/${anchor}.md` | The anchor piece itself; it is the best brief there is |

## Tool contract

```bash
SKILL="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/Writing/Tools"
VOICE_DIR="$(bun $SKILL/WritingConfig.ts voice-dir)"   # exits 2 and names Setup.md when not configured

# Deterministic: bands, forbidden constructions, per-metric remedies
bun $SKILL/VoiceGate.ts <draft>

# Model-graded: six corpus-derived dimensions, judged against the exemplars
bun $SKILL/VoiceJudge.ts <draft>

# Where a draft sits against every band, side by side
bun $SKILL/BuildVoiceProfile.ts --manifest $VOICE_DIR/Corpus.md --compare <draft>

# Regenerate bands after editing the corpus
bun $SKILL/BuildVoiceProfile.ts --manifest $VOICE_DIR/Corpus.md --out $VOICE_DIR/VoiceProfile.json
```

The gate prints a specific remedy per failing metric. Those remedies are the revision
instructions — they name what to add, not what to delete. A HIGH finding on a core metric
is descriptive, and the line shows the anchor's own value beside the band: if the draft
is high where the anchor is high, leave it.

The corpus model says how the principal writes; the content index, when one is configured as `corpus_cli`, says what they have already said:

```bash
C="<corpus_cli from Config.md>"   # optional; skip and say so when unset
bun $C status                      # the index's last-sync date
bun $C opinion "<topic>"           # the principal's stance, with dated linked excerpts
bun $C post "<topic>" 5            # the pieces to read whole before writing
```

## Gotchas

The staccato failure of ban-list-only rewrites and the "both gates are necessary, not sufficient" limit are in `References/CompleteGuide.md` § Gotchas, which every bundle loads.

- **Short drafts are unjudgeable by metric.** Under 300 words the vector is noise; the gate
  says so and you rely on the judge and on reading it.

## References

Invoked from a blog-publish workflow, from a social-post workflow for long-form, or directly
on any draft written in the principal's voice. The regression suite proving the intent still
produces that voice is the `voice-principal` Assay suite named in this skill's frontmatter,
which each install builds from its own corpus.
