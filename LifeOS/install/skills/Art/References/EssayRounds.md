# Essay evaluation rounds

Moved out of `Intents/Essay.md` § Step 8: The evaluation round and § Gotchas. Read it when reading an `EvalRound.ts` table (what each stage proves and how the winner is picked) or when a candidate failed a Validation Checklist row and the next round's prompt needs a fix. The command, the loop rule and the read-the-winner gate stay in the intent; the tool's full contract is `Tools/EvalRound.help.md`.

## What the round runs

What it runs (contracts: `Art/Tools/EvalRound.help.md`):

| Stage | What it proves |
|-------|----------------|
| 1 · Assert gate | The file is a usable header at all: wide enough, and any text in it is real words, not model gibberish. Deterministic, local, free. A candidate that fails here is never shown to a judge. |
| 2 · Blind describer | What a stranger sees. The describer gets the IMAGE and nothing else — no article, no thesis brief, no title — and returns a plain description plus what it thinks the image is about. If the argument is not in the pixels, it is not in the description. |
| 3 · Meaning ladder | How much of the argument the description recovers, on four anchored rungs: **1 unrelated · 2 topic only · 3 argument · 4 specific claim**. The ladder judge grades the DESCRIPTION against the argument summary (the `reference:`), never the image and never the title; it quotes the description's deciding phrases before choosing a rung and takes the lower rung when torn. Rung 4 is euphoric surprise: the image that makes a reader feel the essay before reading it. Pass is rung 3; ship on rung 4. |
| 4 · Flipped tournament | Which of the survivors is best. A bracket in code: every pair judged twice with the order flipped (a winner that flips with the order is position bias and counts as a tie), the bracket rerun on shuffled seeding, unstable when the winner differs. The result names the generator and the judge and flags a same-family pair. |
| + · Cross-vendor critique | The ArtDirection panel scores craft against `Brief.json` and names ranked defects. Each candidate's report lands at `<out>/critique/<name>/Critique.json`, which is the `--critique` path `Deliver.ts` needs. |

The asserts run first and gate everything else. The ladder, the critique and the tournament then start together over the survivors. A stage that stalls or fails is reported as UNKNOWN for that candidate, and the round still finishes. The winner is picked in code: assert pass, rung 3 or higher, and no critical critique defect are required; eligible candidates rank by critique pass, then critique median, then stable tournament winner, then tournament pair wins, then rung. On a full tie the incumbent holds. The table shows every candidate's assert result, rung, blind description, per-vendor critique medians, top defects and tournament result, plus the winner and the reason. When no candidate is eligible, `carry forward` names the next round's `--incumbent`. Exit 0 means the winner cleared the bar.


## Common validation failures and the prompt fix

| Problem | Fix |
|---------|-----|
| Subjects too small, too much empty space, background dominates | "LARGE SUBJECTS that FILL THE FRAME", "subjects are DOMINANT focus", and say what fills each region |
| Setting not recognizable | "SETTING: [location]" with "2-3 KEY OBJECTS that establish location" — gym needs weights/bench visible |
| Figures look like cartoons, lines single/clean, figures flat | "GESTURAL ABSTRACTION", the figure-study references and stroke density from `PREFERENCES.md` § Character design (default: "architectural concept-sketch figure studies", "many overlapping strokes per figure"), "MULTIPLE OVERLAPPING LINES", "HATCHING creates depth", "figures have PRESENCE and WEIGHT" |
| No emotion on faces | "dark charcoal strokes for eyes area", "line for mouth angle", "head TILT conveys emotion", "SUGGESTED expression" |
| Too illustrated/rendered, objects too detailed | "GESTURAL SKETCH quality", "quick energetic marks", "objects implied through hatching", "same sketch quality as figures" |
| Wrong emotion | Adjust POSTURE and LINE QUALITY — leaning = relaxed, rigid = tense, dense hatching = weight |
| Colors too solid | "atmospheric washes", "tints over charcoal", "not solid fills" |
| Generic AI look | the artist references from `PREFERENCES.md` § Core aesthetic and § Character design; "architectural concept sketches" when none are set |

