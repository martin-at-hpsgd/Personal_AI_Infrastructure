---
provenance: template
version: 1.0.0
convention: lifeos-freshness-v1
last_updated: 1970-01-01T00:00:00Z
last_updated_by: bootstrap-template
voice_dir: LIFEOS/USER/PRINCIPAL/VOICE
preview_browser: Safari
---

# Writing config

Read by the writing skill's `Tools/WritingConfig.ts`. `voice_dir` is the only required key; it names the directory that will hold your voice model (`Corpus.md`, `Exemplars.md`, `PostExemplars.md`, `VoiceProfile.md`, and the generated `VoiceProfile.json`). Until those files exist, the voice gate and judge report that the model is not configured. The skill's `Setup.md` walks through each file and every optional key.

Optional keys you can add to the frontmatter above:

- `corpus_cli`: path to a CLI that searches your published writing (`status`, `opinion "<topic>"`, `post "<topic>" <n>`).
- `judge_hedge_examples`, `judge_plain_word_examples`, `judge_excitement_examples`, `judge_worry_examples`: example phrases from your own writing for the voice judge's rubrics.
- `remedy_hedges`, `remedy_intensifiers`: words the voice gate suggests in two of its remedies.
- `sentence_reach_words`: the word range your explanatory sentences reach, e.g. `25-40`; the voice judge and gate name it. Unset, they ask for long sentences with no range.
- `banned_patterns`, `hard_zero`, `house_style_only`: comma-separated construction names, or `none`, that replace the voice gate's default checks (which constructions are counted, which fail a draft outright, and which are fixed as house style). Leave them out to keep the defaults; Setup.md lists the names.

Optional sections you can add below, each as a `## ` heading of exactly this name:

- `Short-form judge note`: one standing note added to every short-post rubric.
- `Install notes`: your own rulings about your voice, one bullet each.
- `Calibration log`: one row each time you recalibrate the voice gate against your corpus.

Your preferred register for the long-form voice judge is a taste, so it lives in `PREFERENCES.md` beside this file (`## Register rubric`), not here.
