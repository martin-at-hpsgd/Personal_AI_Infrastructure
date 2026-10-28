---
provenance: template
version: 1.0.0
---

# VOICE — your measured voice model

> Builds without a writing skill ship this directory dormant: nothing reads it until a writing skill that carries the voice tools is installed.

The writing skill writes as you against a model measured from prose you actually wrote, not against a ban list alone. The model is data and lives here; the skill holds none of it.

| File | What it is | How it is made |
|---|---|---|
| `Corpus.md` | Manifest of long-form pieces you wrote yourself: the selection rule, exclusions with reasons, `corpus_root:` (where the source files are) and `anchor:` (the one piece you like best of your own) in its frontmatter | You author it |
| `Exemplars.md` | Verbatim passages from the corpus, tagged by the move they show; material the writing skill can compare against | You curate it from the corpus |
| `VoiceProfile.md` | The readable positive model: the moves your prose makes, each with a measured number or a cited passage; § The anchor piece holds the anchor's moves | You write it from the metrics |
| `VoiceProfile.json` | Measured p10/p50/p90 bands per metric plus `hard_zero` and `house_style_only`; what the writing skill checks | `bun skills/WriteStory/Tools/BuildVoiceProfile.ts --manifest Corpus.md --out VoiceProfile.json` |

Until these exist, the writing skill's voice checks report that the profile is not configured.

Fresh-install state: this README only.
