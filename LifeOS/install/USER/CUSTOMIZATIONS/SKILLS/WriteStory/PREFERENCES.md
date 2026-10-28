---
provenance: template
version: 1.0.0
---

# WriteStory preferences

> Applied by the WriteStory skill when this directory exists (`skills/WriteStory/SKILL.md` line 107): default genre, aesthetic, and voice. Read as prose. Each book's own choices, recorded in its `projects/<book-slug>/interview.md`, override anything here. Every section is optional.

## Default genre

- Genre: (blank; literary, speculative, crime, fantasy, ...)
- Typical length: short story / novella / novel / series

## Aesthetic profile

Name a built-in profile from `skills/WriteStory/AestheticProfiles.md` (§ Built-In Profiles) or define your own with the Custom Profile Template from that file (lines 150-172). Blank means the Interview picks one from your favorites.

- Profile: (blank)

### Custom profile

**Signature:** (one sentence defining the voice)

**Characteristics:**
- (sentence structure preference)
- (vocabulary range and register)
- (key techniques or conventions)

**Rhetorical figure emphasis:** (3-6 figures from `RhetoricalFigures.md`)
**Sentence length:** (Short / Medium / Long / Variable, with a typical range)
**Descriptive density:** (Low / Moderate / High, and what gets described most)
**Pacing:** (Fast / Moderate / Slow / Variable)

**Sample register:**
> (one representative sentence in the voice)

## Voice anchors

The Interview asks for these per book (`Intents/Interview.md` line 22). Standing answers go here.

- Favorites: 3-5 stories you love and what specifically you loved about each
- Sample of your own prose: `~/Writing/samples/`
- Reader target: what a reader should feel on finishing

## Voice-profile bans

Read by `Tools/BuildVoiceProfile.ts` and copied into every `VoiceProfile.json`. `hard_zero` names constructions held at zero whatever the corpus does; `house_style_only` names formatting habits the corpus contains that drafts fix on sight. Both keys are required when this section exists; leave a value empty for none. Names come from the pattern detectors in `Tools/VoiceMetrics.ts`.

- hard_zero: negation-pair, heres-the-thing
- house_style_only:

## House rules

- Anti-cliche sweep from `AntiCliche.md` runs on every draft; add your own banned phrases here
- Only WriteChapter emits prose, and only off a confirmed Story Bible
